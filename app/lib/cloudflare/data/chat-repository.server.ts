import type { ChatRow } from './types';
import { DataNotFoundError } from './errors';

const CHAT_COLUMNS =
  'chats.id, chats.creator_id, chats.initial_id, chats.description, chats.timestamp, chats.last_subchat_index, chats.has_messages, chats.is_deleted';

type ChatInsertArgs = {
  id: string;
  creatorId: string;
  initialId: string;
  description?: string | null;
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
          chat_id, subchat_index, generation, agent_name,
          parent_subchat_index, parent_generation, parent_revision, transition_token,
          created_at, updated_at
        )
        SELECT chats.id, 0, 0, chats.initial_id, NULL, NULL, NULL, ?, ?, ?
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

/** Record only the catalog fact that an Agent accepted content; the Agent owns the checkpoint. */
export async function markChatStarted(
  db: D1Database,
  args: { sessionId: string; chatId: string; agentName: string },
): Promise<void> {
  await db
    .prepare(
      `UPDATE chats
       SET has_messages = 1
       WHERE creator_id = ? AND initial_id = ? AND is_deleted = 0
         AND EXISTS (
           SELECT 1 FROM chat_transcripts
           WHERE chat_transcripts.chat_id = chats.id AND chat_transcripts.agent_name = ?
         )`,
    )
    .bind(args.sessionId, args.chatId, args.agentName)
    .run();
}

function prepareInsertChat(db: D1Database, args: ChatInsertArgs, ignoreInitialConflict = false): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO chats (
        id, creator_id, initial_id, description, timestamp, last_subchat_index, has_messages, is_deleted
      )
      SELECT ?, ?, ?, ?, ?, ?, 0, ?
      WHERE NOT EXISTS (SELECT 1 FROM chats WHERE initial_id = ?)
      ${ignoreInitialConflict ? 'ON CONFLICT DO NOTHING' : ''}`,
    )
    .bind(
      args.id,
      args.creatorId,
      args.initialId,
      args.description ?? null,
      new Date().toISOString(),
      0,
      0,
      args.initialId,
    );
}
