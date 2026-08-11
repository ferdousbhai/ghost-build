import type { TranscriptCheckpoint } from 'ghostbuild-agent/transcript';
import type { ChatRow } from './types';
import { DataNotFoundError } from './errors';
import { checkpointMatchesIdentity, requireChatTranscript } from './transcript-repository.server';

const CHAT_COLUMNS =
  'chats.id, chats.creator_id, chats.initial_id, chats.description, chats.timestamp, chats.last_subchat_index, chats.is_deleted';

type ChatInsertArgs = {
  id: string;
  creatorId: string;
  initialId: string;
  description?: string | null;
  lastSubchatIndex?: number;
};

type UpdateChatCheckpointArgs = {
  sessionId: string;
  chatId: string;
  lastMessageRank: number;
  subchatIndex: number;
  partIndex: number;
  checkpoint: TranscriptCheckpoint;
};

export async function ensureInitialChat(
  db: D1Database,
  args: { id: string; creatorId: string; initialId: string },
): Promise<ChatRow & { created: boolean }> {
  const createdAt = Date.now();
  const results = await db.batch([
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
  ]);

  const chat = await db
    .prepare(
      `SELECT ${CHAT_COLUMNS} FROM chats
       WHERE chats.creator_id = ? AND chats.initial_id = ? AND chats.is_deleted = 0
       LIMIT 1`,
    )
    .bind(args.creatorId, args.initialId)
    .first<ChatRow>();
  if (!chat) {
    throw new Error('Unable to initialize chat');
  }
  return { ...chat, created: results[0].meta.changes > 0 };
}

export function findChat(db: D1Database, args: { id: string; sessionId: string }): Promise<ChatRow | null> {
  return db
    .prepare(
      `SELECT ${CHAT_COLUMNS} FROM chats
       WHERE chats.creator_id = ? AND chats.initial_id = ? AND chats.is_deleted = 0
       LIMIT 1`,
    )
    .bind(args.sessionId, args.id)
    .first<ChatRow>();
}

export async function requireChat(db: D1Database, args: { id: string; sessionId: string }): Promise<ChatRow> {
  const chat = await findChat(db, args);
  if (!chat) {
    throw new DataNotFoundError('Chat not found');
  }
  return chat;
}

/** Persist only the current chat catalog checkpoint; message bodies stay in BuilderAgent. */
export async function updateChatCheckpoint(
  db: D1Database,
  args: UpdateChatCheckpointArgs,
): Promise<{ accepted: boolean }> {
  const chat = await requireChat(db, { id: args.chatId, sessionId: args.sessionId });
  const transcript = await requireChatTranscript(db, { chatId: chat.id, subchatIndex: args.subchatIndex });
  if (!checkpointMatchesIdentity(args.checkpoint, transcript)) {
    return { accepted: false };
  }
  if (
    transcript.head_revision > args.checkpoint.revision ||
    transcript.last_message_rank > args.lastMessageRank ||
    (transcript.last_message_rank === args.lastMessageRank && transcript.part_index > args.partIndex) ||
    (transcript.head_revision === args.checkpoint.revision &&
      transcript.head_digest !== null &&
      transcript.head_digest !== args.checkpoint.digest)
  ) {
    return { accepted: false };
  }
  if (
    transcript.head_revision === args.checkpoint.revision &&
    (transcript.last_message_rank !== args.lastMessageRank || transcript.part_index !== args.partIndex)
  ) {
    return { accepted: false };
  }
  if (
    transcript.head_revision === args.checkpoint.revision &&
    transcript.head_digest === args.checkpoint.digest &&
    transcript.head_message_count === args.checkpoint.messageCount &&
    transcript.last_message_rank === args.lastMessageRank &&
    transcript.part_index === args.partIndex
  ) {
    return { accepted: true };
  }

  // BuilderAgent owns message history. D1 keeps one monotonic catalog projection;
  // subchat creation already advances chats.last_subchat_index transactionally.
  const result = await db
    .prepare(
      `UPDATE chat_transcripts
       SET head_revision = ?, head_digest = ?, head_message_count = ?,
           last_message_rank = ?, part_index = ?, updated_at = ?
       WHERE chat_id = ? AND subchat_index = ? AND generation = ? AND agent_name = ?
         AND head_revision <= ?
         AND (head_revision < ? OR head_digest IS NULL OR head_digest = ?)
         AND (last_message_rank < ? OR (last_message_rank = ? AND part_index <= ?))
         AND EXISTS (
           SELECT 1 FROM chats
           WHERE chats.id = chat_transcripts.chat_id AND chats.creator_id = ? AND chats.is_deleted = 0
         )`,
    )
    .bind(
      args.checkpoint.revision,
      args.checkpoint.digest,
      args.checkpoint.messageCount,
      args.lastMessageRank,
      args.partIndex,
      Date.now(),
      chat.id,
      args.subchatIndex,
      args.checkpoint.generation,
      args.checkpoint.agentName,
      args.checkpoint.revision,
      args.checkpoint.revision,
      args.checkpoint.digest,
      args.lastMessageRank,
      args.lastMessageRank,
      args.partIndex,
      args.sessionId,
    )
    .run();
  return { accepted: result.meta.changes === 1 };
}

function prepareInsertChat(db: D1Database, args: ChatInsertArgs, ignoreInitialConflict = false): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO chats (
        id, creator_id, initial_id, description, timestamp, last_subchat_index, is_deleted
      )
      SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM chats WHERE initial_id = ?)
      ${ignoreInitialConflict ? 'ON CONFLICT DO NOTHING' : ''}`,
    )
    .bind(
      args.id,
      args.creatorId,
      args.initialId,
      args.description ?? null,
      new Date().toISOString(),
      args.lastSubchatIndex ?? 0,
      0,
      args.initialId,
    );
}
