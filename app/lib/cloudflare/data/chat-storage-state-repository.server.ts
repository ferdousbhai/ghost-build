import type { TranscriptCheckpoint } from 'ghostbuild-agent/transcript';
import { ChatStorageRetentionError } from './errors';
import { prepareObjectGcCandidateStatements } from './object-gc.server';
import { checkpointMatchesIdentity, requireChatTranscript } from './transcript-repository.server';
import type { ChatMessageStateRow, ChatRow } from './types';

const MAX_STORAGE_UPDATE_CAS_ATTEMPTS = 8;
const MAX_RETENTION_PRUNE_STATES_PER_REQUEST = 24;
export const MAX_RETAINED_CHAT_STORAGE_STATES = 32;

type RetentionCandidateRow = Pick<ChatMessageStateRow, 'id' | 'storage_key' | 'snapshot_key'>;

export type UpdateStorageStateArgs = {
  sessionId: string;
  chatId: string;
  storageKey: string | null;
  snapshotKey: string | null;
  lastMessageRank: number;
  subchatIndex: number;
  partIndex: number;
  initialDescription?: string | null;
  checkpoint: TranscriptCheckpoint;
};

export type UpdateStorageStateResult = {
  accepted: boolean;
  retainedStorageKey: boolean;
  retainedSnapshotKey: boolean;
  displacedKeys: string[];
};

type RequireChat = (db: D1Database, args: { id: string; sessionId: string }) => Promise<ChatRow>;

export function getLatestStorageState(
  db: D1Database,
  args: { chatId: string; subchatIndex: number; lastMessageRank?: number },
): Promise<ChatMessageStateRow | null> {
  return requireChatTranscript(db, args).then((transcript) =>
    getLatestStorageStateForGeneration(db, {
      ...args,
      generation: transcript.generation,
    }),
  );
}

export function getLatestStorageStateForGeneration(
  db: D1Database,
  args: { chatId: string; subchatIndex: number; generation: number; lastMessageRank?: number },
): Promise<ChatMessageStateRow | null> {
  if (args.lastMessageRank === undefined) {
    return db
      .prepare(
        `SELECT * FROM chat_message_states
         WHERE chat_id = ? AND subchat_index = ? AND transcript_generation = ?
         ORDER BY last_message_rank DESC, part_index DESC
         LIMIT 1`,
      )
      .bind(args.chatId, args.subchatIndex, args.generation)
      .first<ChatMessageStateRow>();
  }
  return db
    .prepare(
      `SELECT * FROM chat_message_states
       WHERE chat_id = ? AND subchat_index = ? AND transcript_generation = ? AND last_message_rank <= ?
       ORDER BY last_message_rank DESC, part_index DESC
       LIMIT 1`,
    )
    .bind(args.chatId, args.subchatIndex, args.generation, args.lastMessageRank)
    .first<ChatMessageStateRow>();
}

export async function enforceChatStorageRetention(
  db: D1Database,
  args: { chatId: string; reserveStates: 0 | 1 },
): Promise<void> {
  const maximumExistingStates = MAX_RETAINED_CHAT_STORAGE_STATES - args.reserveStates;
  const stateCount = await getChatStorageStateCount(db, args.chatId);
  const excess = stateCount - maximumExistingStates;
  if (excess <= 0) {
    return;
  }

  const candidates = await db
    .prepare(
      `SELECT id, storage_key, snapshot_key
       FROM chat_message_states
       WHERE chat_id = ?
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
    )
    .bind(args.chatId, Math.min(excess, MAX_RETENTION_PRUNE_STATES_PER_REQUEST))
    .all<RetentionCandidateRow>();
  const statements: D1PreparedStatement[] = [];
  const deleteStatementIndexes: number[] = [];
  for (const candidate of candidates.results) {
    deleteStatementIndexes.push(statements.length);
    statements.push(
      db.prepare('DELETE FROM chat_message_states WHERE id = ? AND chat_id = ?').bind(candidate.id, args.chatId),
      ...prepareObjectGcCandidateStatements(db, [candidate.storage_key, candidate.snapshot_key]),
    );
  }
  const results = statements.length > 0 ? await db.batch(statements) : [];
  const pruned = deleteStatementIndexes.reduce(
    (total, index) => total + (results[index]?.meta.changes === 1 ? 1 : 0),
    0,
  );
  if (stateCount - pruned > maximumExistingStates) {
    throw new ChatStorageRetentionError();
  }
}

export async function updateStorageStateWithChatLookup(
  db: D1Database,
  args: UpdateStorageStateArgs,
  requireChat: RequireChat,
): Promise<UpdateStorageStateResult> {
  const chat = await requireChat(db, { id: args.chatId, sessionId: args.sessionId });
  const transcript = await requireChatTranscript(db, { chatId: chat.id, subchatIndex: args.subchatIndex });
  if (!checkpointMatchesIdentity(args.checkpoint, transcript)) {
    return rejectedStorageUpdate();
  }
  if (
    transcript.head_revision > args.checkpoint.revision ||
    (transcript.head_revision === args.checkpoint.revision &&
      transcript.head_digest !== null &&
      transcript.head_digest !== args.checkpoint.digest)
  ) {
    return rejectedStorageUpdate();
  }
  for (let attempt = 0; attempt < MAX_STORAGE_UPDATE_CAS_ATTEMPTS; attempt++) {
    const previous = await getLatestStorageStateForGeneration(db, {
      chatId: chat.id,
      subchatIndex: args.subchatIndex,
      generation: transcript.generation,
    });
    if (!previous) {
      if (!(await isOwnedChatActive(db, chat.id, args.sessionId))) {
        return rejectedStorageUpdate();
      }
      throw new Error('Chat messages storage state not found');
    }
    if (previous.transcript_revision > args.checkpoint.revision || previous.last_message_rank > args.lastMessageRank) {
      return rejectedStorageUpdate();
    }
    if (previous.last_message_rank === args.lastMessageRank && previous.part_index > args.partIndex) {
      return rejectedStorageUpdate();
    }
    if (
      previous.transcript_revision === args.checkpoint.revision &&
      (previous.last_message_rank !== args.lastMessageRank ||
        previous.part_index !== args.partIndex ||
        (previous.transcript_digest !== null && previous.transcript_digest !== args.checkpoint.digest))
    ) {
      return rejectedStorageUpdate();
    }
    const samePosition = previous.last_message_rank === args.lastMessageRank && previous.part_index === args.partIndex;
    if (samePosition && previous.transcript_revision === args.checkpoint.revision) {
      const result = await db
        .prepare(
          `UPDATE chat_message_states
           SET snapshot_key = COALESCE(snapshot_key, ?), description = COALESCE(description, ?)
           WHERE id = ? AND EXISTS (
             SELECT 1 FROM chats
             WHERE chats.id = chat_message_states.chat_id AND chats.creator_id = ? AND chats.is_deleted = 0
           )`,
        )
        .bind(args.snapshotKey, args.initialDescription ?? null, previous.id, args.sessionId)
        .run();
      if (result.meta.changes === 0) {
        if (!(await isOwnedChatActive(db, chat.id, args.sessionId))) {
          return rejectedStorageUpdate();
        }
        continue;
      }
      const current = await getStorageStateById(db, previous.id);
      return {
        accepted: true,
        retainedStorageKey: false,
        retainedSnapshotKey: args.snapshotKey !== null && current?.snapshot_key === args.snapshotKey,
        displacedKeys: [],
      };
    }
    if (previous.last_message_rank === args.lastMessageRank) {
      const displaced = displacedKeys(previous, args);
      const results = await db.batch([
        prepareAdvanceTranscriptStatement(db, chat.id, args.sessionId, args.checkpoint),
        db
          .prepare(
            `UPDATE chat_message_states
             SET storage_key = COALESCE(?, storage_key), part_index = ?,
                 snapshot_key = COALESCE(?, snapshot_key), description = COALESCE(description, ?),
                 transcript_revision = ?, transcript_digest = ?
             WHERE id = ? AND last_message_rank = ? AND part_index = ? AND transcript_revision = ?
               AND storage_key IS ? AND snapshot_key IS ?
               AND EXISTS (
                 SELECT 1 FROM chat_transcripts
                 JOIN chats ON chats.id = chat_transcripts.chat_id
                 WHERE chat_transcripts.chat_id = ? AND chat_transcripts.subchat_index = ?
                   AND chat_transcripts.generation = ? AND chat_transcripts.agent_name = ?
                   AND chat_transcripts.head_revision = ? AND chat_transcripts.head_digest = ?
                   AND chats.creator_id = ? AND chats.is_deleted = 0
               )`,
          )
          .bind(
            args.storageKey,
            args.partIndex,
            args.snapshotKey,
            args.initialDescription ?? null,
            args.checkpoint.revision,
            args.checkpoint.digest,
            previous.id,
            previous.last_message_rank,
            previous.part_index,
            previous.transcript_revision,
            previous.storage_key,
            previous.snapshot_key,
            chat.id,
            args.checkpoint.subchatIndex,
            args.checkpoint.generation,
            args.checkpoint.agentName,
            args.checkpoint.revision,
            args.checkpoint.digest,
            args.sessionId,
          ),
        ...prepareObjectGcCandidateStatements(db, displaced),
      ]);
      if (results[0].meta.changes === 0 || results[1].meta.changes === 0) {
        if (!(await isOwnedChatActive(db, chat.id, args.sessionId))) {
          return rejectedStorageUpdate();
        }
        continue;
      }
      return acceptedStorageUpdate(args, displaced);
    }

    const stateId = crypto.randomUUID();
    const results = await db.batch([
      prepareAdvanceTranscriptStatement(db, chat.id, args.sessionId, args.checkpoint),
      db
        .prepare(
          `INSERT INTO chat_message_states (
            id, chat_id, storage_key, subchat_index, last_message_rank, part_index,
            snapshot_key, description, created_at, transcript_generation, transcript_revision, transcript_digest
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          FROM chat_transcripts
          JOIN chats ON chats.id = chat_transcripts.chat_id
          WHERE chat_transcripts.chat_id = ? AND chat_transcripts.subchat_index = ?
            AND chat_transcripts.generation = ? AND chat_transcripts.agent_name = ?
            AND chat_transcripts.head_revision = ? AND chat_transcripts.head_digest = ?
            AND chats.creator_id = ? AND chats.is_deleted = 0
            AND (SELECT COUNT(*) FROM chat_message_states WHERE chat_id = ?) < ?
          ON CONFLICT DO NOTHING`,
        )
        .bind(
          stateId,
          chat.id,
          args.storageKey,
          args.subchatIndex,
          args.lastMessageRank,
          args.partIndex,
          args.snapshotKey ?? previous.snapshot_key,
          previous.description ?? args.initialDescription ?? null,
          Date.now(),
          args.checkpoint.generation,
          args.checkpoint.revision,
          args.checkpoint.digest,
          chat.id,
          args.checkpoint.subchatIndex,
          args.checkpoint.generation,
          args.checkpoint.agentName,
          args.checkpoint.revision,
          args.checkpoint.digest,
          args.sessionId,
          chat.id,
          MAX_RETAINED_CHAT_STORAGE_STATES,
        ),
      db
        .prepare(
          `UPDATE chats SET last_message_rank = NULL, last_subchat_index = ?
           WHERE id = ? AND creator_id = ? AND is_deleted = 0
             AND EXISTS (SELECT 1 FROM chat_message_states WHERE id = ?)`,
        )
        .bind(args.subchatIndex, chat.id, args.sessionId, stateId),
    ]);
    if (
      (results[0].meta.changes === 0 || results[1].meta.changes === 0) &&
      !(await isOwnedChatActive(db, chat.id, args.sessionId))
    ) {
      return rejectedStorageUpdate();
    }
    if (
      results[1].meta.changes === 0 &&
      (await getChatStorageStateCount(db, chat.id)) >= MAX_RETAINED_CHAT_STORAGE_STATES
    ) {
      throw new ChatStorageRetentionError();
    }
    if (results[0].meta.changes === 0 || results[1].meta.changes === 0) {
      continue;
    }
    return acceptedStorageUpdate(args);
  }
  throw new Error('Chat storage state changed too many times; retry the save');
}

async function getChatStorageStateCount(db: D1Database, chatId: string): Promise<number> {
  const count = await db
    .prepare('SELECT COUNT(*) AS state_count FROM chat_message_states WHERE chat_id = ?')
    .bind(chatId)
    .first<{ state_count: number }>();
  return count?.state_count ?? 0;
}

function prepareAdvanceTranscriptStatement(
  db: D1Database,
  chatId: string,
  ownerId: string,
  checkpoint: TranscriptCheckpoint,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE chat_transcripts
       SET head_revision = ?, head_digest = ?, head_message_count = ?, updated_at = ?
       WHERE chat_id = ? AND subchat_index = ? AND generation = ?
         AND head_revision <= ?
         AND (head_revision < ? OR head_digest IS NULL OR head_digest = ?)
         AND EXISTS (
           SELECT 1 FROM chats
           WHERE chats.id = chat_transcripts.chat_id AND chats.creator_id = ? AND chats.is_deleted = 0
         )`,
    )
    .bind(
      checkpoint.revision,
      checkpoint.digest,
      checkpoint.messageCount,
      Date.now(),
      chatId,
      checkpoint.subchatIndex,
      checkpoint.generation,
      checkpoint.revision,
      checkpoint.revision,
      checkpoint.digest,
      ownerId,
    );
}

async function isOwnedChatActive(db: D1Database, chatId: string, ownerId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS found FROM chats WHERE id = ? AND creator_id = ? AND is_deleted = 0')
    .bind(chatId, ownerId)
    .first<{ found: number }>();
  return row !== null;
}

function getStorageStateById(db: D1Database, id: string): Promise<ChatMessageStateRow | null> {
  return db.prepare('SELECT * FROM chat_message_states WHERE id = ?').bind(id).first<ChatMessageStateRow>();
}

function rejectedStorageUpdate(): UpdateStorageStateResult {
  return {
    accepted: false,
    retainedStorageKey: false,
    retainedSnapshotKey: false,
    displacedKeys: [],
  };
}

function acceptedStorageUpdate(
  args: Pick<UpdateStorageStateArgs, 'storageKey' | 'snapshotKey'>,
  displacedKeys: string[] = [],
): UpdateStorageStateResult {
  return {
    accepted: true,
    retainedStorageKey: args.storageKey !== null,
    retainedSnapshotKey: args.snapshotKey !== null,
    displacedKeys,
  };
}

function displacedKeys(
  previous: ChatMessageStateRow,
  next: Pick<UpdateStorageStateArgs, 'storageKey' | 'snapshotKey'>,
): string[] {
  return [
    next.storageKey !== null && previous.storage_key !== next.storageKey ? previous.storage_key : null,
    next.snapshotKey !== null && previous.snapshot_key !== next.snapshotKey ? previous.snapshot_key : null,
  ].filter((key): key is string => key !== null);
}
