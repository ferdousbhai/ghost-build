import type { TranscriptCheckpoint } from 'ghostbuild-agent/transcript';
import type { ChatMessageStateRow, ChatRow } from './types';
import { prepareObjectGcCandidateStatements } from './object-gc.server';
import {
  checkpointMatchesIdentity,
  prepareInsertChatTranscript,
  requireChatTranscript,
} from './transcript-repository.server';

const MAX_STORAGE_UPDATE_CAS_ATTEMPTS = 8;

type ChatInsertArgs = {
  id: string;
  creatorId: string;
  initialId: string;
  description?: string | null;
  snapshotKey?: string | null;
  lastSubchatIndex?: number;
};

type ChatMessageStateInsertArgs = {
  id?: string;
  chatId: string;
  storageKey?: string | null;
  subchatIndex: number;
  lastMessageRank: number;
  partIndex: number;
  snapshotKey?: string | null;
  description?: string | null;
  transcriptGeneration?: number;
  transcriptRevision?: number;
  transcriptDigest?: string | null;
};

export async function insertChatWithState(
  db: D1Database,
  chat: ChatInsertArgs,
  state: Omit<ChatMessageStateInsertArgs, 'chatId'>,
): Promise<string> {
  const stateId = state.id ?? crypto.randomUUID();
  await db.batch([
    prepareInsertChat(db, chat),
    prepareInsertChatTranscript(db, {
      chatId: chat.id,
      initialId: chat.initialId,
      subchatIndex: state.subchatIndex,
      generation: state.transcriptGeneration,
      headRevision: state.transcriptRevision,
      headDigest: state.transcriptDigest,
    }),
    prepareInsertChatMessageState(db, { ...state, id: stateId, chatId: chat.id }),
  ]);
  return stateId;
}

export async function ensureInitialChat(
  db: D1Database,
  args: { id: string; creatorId: string; initialId: string },
): Promise<ChatRow> {
  const createdAt = Date.now();
  await db.batch([
    prepareInsertChat(db, args, true),
    db
      .prepare(
        `INSERT INTO chat_transcripts (
          chat_id, subchat_index, generation, agent_name, head_revision, head_digest,
          head_message_count, parent_subchat_index, parent_generation, parent_revision, transition_token,
          created_at, updated_at
        )
        SELECT chats.id, 0, 0, chats.initial_id, 0, NULL, 0, NULL, NULL, NULL, ?, ?, ?
        FROM chats
        WHERE chats.id = ? AND chats.creator_id = ? AND chats.initial_id = ? AND chats.is_deleted = 0
        ON CONFLICT(chat_id, subchat_index) DO NOTHING`,
      )
      .bind(crypto.randomUUID(), createdAt, createdAt, args.id, args.creatorId, args.initialId),
    db
      .prepare(
        `INSERT INTO chat_message_states (
          id, chat_id, storage_key, subchat_index, last_message_rank, part_index,
          snapshot_key, description, created_at
        )
        SELECT ?, chats.id, NULL, 0, -1, -1, NULL, NULL, ?
        FROM chats
        WHERE chats.id = ? AND chats.creator_id = ? AND chats.initial_id = ? AND chats.is_deleted = 0
        ON CONFLICT(chat_id, subchat_index, transcript_generation, last_message_rank) DO NOTHING`,
      )
      .bind(crypto.randomUUID(), createdAt, args.id, args.creatorId, args.initialId),
  ]);

  const chat = await db
    .prepare(
      `SELECT * FROM chats
       WHERE creator_id = ? AND initial_id = ? AND is_deleted = 0
       LIMIT 1`,
    )
    .bind(args.creatorId, args.initialId)
    .first<ChatRow>();
  if (!chat) {
    throw new Error('Unable to initialize chat');
  }
  return chat;
}

export function findChat(db: D1Database, args: { id: string; sessionId: string }): Promise<ChatRow | null> {
  return db
    .prepare(
      `SELECT * FROM chats
       WHERE creator_id = ? AND (initial_id = ? OR url_id = ?) AND is_deleted = 0
       LIMIT 1`,
    )
    .bind(args.sessionId, args.id, args.id)
    .first<ChatRow>();
}

export async function requireChat(db: D1Database, args: { id: string; sessionId: string }): Promise<ChatRow> {
  const chat = await findChat(db, args);
  if (!chat) {
    throw new Error('Chat not found');
  }
  return chat;
}

export async function requireChatByPrimaryId(db: D1Database, id: string, errorMessage: string): Promise<ChatRow> {
  const chat = await db.prepare('SELECT * FROM chats WHERE id = ?').bind(id).first<ChatRow>();
  if (!chat) {
    throw new Error(errorMessage);
  }
  return chat;
}

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

export async function updateStorageState(
  db: D1Database,
  args: {
    sessionId: string;
    chatId: string;
    storageKey: string | null;
    snapshotKey: string | null;
    lastMessageRank: number;
    subchatIndex: number;
    partIndex: number;
    initialDescription?: string | null;
    checkpoint: TranscriptCheckpoint;
  },
): Promise<{
  accepted: boolean;
  retainedStorageKey: boolean;
  retainedSnapshotKey: boolean;
  displacedKeys: string[];
}> {
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
      await db
        .prepare(
          `UPDATE chat_message_states
           SET snapshot_key = COALESCE(snapshot_key, ?), description = COALESCE(description, ?)
           WHERE id = ?`,
        )
        .bind(args.snapshotKey, args.initialDescription ?? null, previous.id)
        .run();
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
        prepareAdvanceTranscriptStatement(db, chat.id, args.checkpoint),
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
                 WHERE chat_id = ? AND subchat_index = ? AND generation = ? AND agent_name = ?
                   AND head_revision = ? AND head_digest = ?
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
          ),
        ...prepareObjectGcCandidateStatements(db, displaced),
      ]);
      if (results[0].meta.changes === 0 || results[1].meta.changes === 0) {
        continue;
      }
      return acceptedStorageUpdate(args, displaced);
    }

    const stateId = crypto.randomUUID();
    const results = await db.batch([
      prepareAdvanceTranscriptStatement(db, chat.id, args.checkpoint),
      db
        .prepare(
          `INSERT INTO chat_message_states (
            id, chat_id, storage_key, subchat_index, last_message_rank, part_index,
            snapshot_key, description, created_at, transcript_generation, transcript_revision, transcript_digest
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          FROM chat_transcripts
          WHERE chat_id = ? AND subchat_index = ? AND generation = ? AND agent_name = ?
            AND head_revision = ? AND head_digest = ?
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
        ),
      db
        .prepare(
          `UPDATE chats SET last_message_rank = NULL, last_subchat_index = ?
           WHERE id = ? AND EXISTS (SELECT 1 FROM chat_message_states WHERE id = ?)`,
        )
        .bind(args.subchatIndex, chat.id, stateId),
    ]);
    if (results[0].meta.changes === 0 || results[1].meta.changes === 0) {
      continue;
    }
    return acceptedStorageUpdate(args);
  }
  throw new Error('Chat storage state changed too many times; retry the save');
}

function prepareAdvanceTranscriptStatement(
  db: D1Database,
  chatId: string,
  checkpoint: TranscriptCheckpoint,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE chat_transcripts
       SET head_revision = ?, head_digest = ?, head_message_count = ?, updated_at = ?
       WHERE chat_id = ? AND subchat_index = ? AND generation = ?
         AND head_revision <= ?
         AND (head_revision < ? OR head_digest IS NULL OR head_digest = ?)`,
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
    );
}

function prepareInsertChat(
  db: D1Database,
  args: ChatInsertArgs,
  ignoreActiveInitialConflict = false,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO chats (
        id, creator_id, initial_id, url_id, description, timestamp, snapshot_key,
        last_message_rank, last_subchat_index, is_deleted
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM chats WHERE initial_id = ?)
      ${ignoreActiveInitialConflict ? 'ON CONFLICT DO NOTHING' : ''}`,
    )
    .bind(
      args.id,
      args.creatorId,
      args.initialId,
      null,
      args.description ?? null,
      new Date().toISOString(),
      args.snapshotKey ?? null,
      null,
      args.lastSubchatIndex ?? 0,
      0,
      args.initialId,
    );
}

function prepareInsertChatMessageState(db: D1Database, args: ChatMessageStateInsertArgs): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO chat_message_states (
        id, chat_id, storage_key, subchat_index, last_message_rank, part_index, snapshot_key, description, created_at,
        transcript_generation, transcript_revision, transcript_digest
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      args.id ?? crypto.randomUUID(),
      args.chatId,
      args.storageKey ?? null,
      args.subchatIndex,
      args.lastMessageRank,
      args.partIndex,
      args.snapshotKey ?? null,
      args.description ?? null,
      Date.now(),
      args.transcriptGeneration ?? 0,
      args.transcriptRevision ?? 0,
      args.transcriptDigest ?? null,
    );
}

function getStorageStateById(db: D1Database, id: string): Promise<ChatMessageStateRow | null> {
  return db.prepare('SELECT * FROM chat_message_states WHERE id = ?').bind(id).first<ChatMessageStateRow>();
}

function rejectedStorageUpdate() {
  return {
    accepted: false,
    retainedStorageKey: false,
    retainedSnapshotKey: false,
    displacedKeys: [],
  };
}

function acceptedStorageUpdate(
  args: Pick<Parameters<typeof updateStorageState>[1], 'storageKey' | 'snapshotKey'>,
  displacedKeys: string[] = [],
) {
  return {
    accepted: true,
    retainedStorageKey: args.storageKey !== null,
    retainedSnapshotKey: args.snapshotKey !== null,
    displacedKeys,
  };
}

function displacedKeys(
  previous: ChatMessageStateRow,
  next: Pick<Parameters<typeof updateStorageState>[1], 'storageKey' | 'snapshotKey'>,
): string[] {
  return [
    next.storageKey !== null && previous.storage_key !== next.storageKey ? previous.storage_key : null,
    next.snapshotKey !== null && previous.snapshot_key !== next.snapshotKey ? previous.snapshot_key : null,
  ].filter((key): key is string => key !== null);
}

export async function allocateUrlId(db: D1Database, sessionId: string, urlHint: string): Promise<string> {
  const base = slugify(urlHint);
  let candidate = base;
  let index = 2;
  while (await findChat(db, { id: candidate, sessionId })) {
    candidate = `${base}-${index}`;
    index++;
  }
  return candidate;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || crypto.randomUUID().slice(0, 8);
}
