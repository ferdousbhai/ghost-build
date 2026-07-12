import { storageUrl } from './object-storage.server';
import {
  allocateUrlId,
  ensureInitialChat,
  findChat,
  getLatestStorageState,
  insertChatMessageState,
  requireChat,
} from './chat-repository.server';

export async function initializeChat(db: D1Database, args: { sessionId: string; id: string }): Promise<null> {
  await ensureInitialChat(db, { id: crypto.randomUUID(), creatorId: args.sessionId, initialId: args.id });
  return null;
}

export async function getChat(db: D1Database, args: { id: string; sessionId: string }) {
  const chat = await findChat(db, args);
  if (!chat) {
    return null;
  }
  return {
    initialId: chat.initial_id,
    urlId: chat.url_id ?? undefined,
    description: chat.description ?? undefined,
    timestamp: chat.timestamp,
    snapshotId: chat.snapshot_key ?? undefined,
    subchatIndex: chat.last_subchat_index,
  };
}

export async function getAllChats(db: D1Database, args: { sessionId: string }) {
  const { results } = await db
    .prepare(
      `SELECT initial_id, url_id, description, timestamp
       FROM chats
       WHERE creator_id = ? AND is_deleted = 0
       ORDER BY timestamp DESC`,
    )
    .bind(args.sessionId)
    .all<{ initial_id: string; url_id: string | null; description: string | null; timestamp: string }>();
  return results.map((row) => ({
    id: row.url_id ?? row.initial_id,
    initialId: row.initial_id,
    urlId: row.url_id ?? undefined,
    description: row.description ?? undefined,
    timestamp: row.timestamp,
  }));
}

export async function setUrlId(
  db: D1Database,
  args: { sessionId: string; chatId: string; urlHint: string; description: string },
) {
  const chat = await requireChat(db, { id: args.chatId, sessionId: args.sessionId });
  if (chat.url_id) {
    return { urlId: chat.url_id, initialId: chat.initial_id };
  }
  const urlId = await allocateUrlId(db, args.sessionId, args.urlHint);
  await db
    .prepare('UPDATE chats SET url_id = ?, description = COALESCE(description, ?) WHERE id = ?')
    .bind(urlId, args.description, chat.id)
    .run();
  return { urlId, initialId: chat.initial_id };
}

export async function setDescription(
  db: D1Database,
  args: { sessionId: string; id: string; description: string },
): Promise<null> {
  const chat = await requireChat(db, { id: args.id, sessionId: args.sessionId });
  await db.prepare('UPDATE chats SET description = ? WHERE id = ?').bind(args.description, chat.id).run();
  return null;
}

export async function removeChat(db: D1Database, args: { sessionId: string; id: string }) {
  const chat = await findChat(db, { id: args.id, sessionId: args.sessionId });
  if (chat) {
    await db.prepare('UPDATE chats SET is_deleted = 1 WHERE id = ?').bind(chat.id).run();
  }
  return { kind: 'success' } as const;
}

export async function earliestRewindableMessageRank(
  db: D1Database,
  args: { sessionId: string; chatId: string; subchatIndex?: number },
): Promise<number | null> {
  const chat = await requireChat(db, { id: args.chatId, sessionId: args.sessionId });
  const subchatIndex = args.subchatIndex ?? chat.last_subchat_index;
  const row = await db
    .prepare(
      `SELECT last_message_rank
       FROM chat_message_states
       WHERE chat_id = ? AND subchat_index = ? AND snapshot_key IS NOT NULL
       ORDER BY last_message_rank ASC, part_index ASC
       LIMIT 1`,
    )
    .bind(chat.id, subchatIndex)
    .first<{ last_message_rank: number }>();
  return row?.last_message_rank ?? null;
}

export async function rewindChat(
  db: D1Database,
  args: { sessionId: string; chatId: string; subchatIndex?: number; lastMessageRank?: number },
): Promise<null> {
  const chat = await requireChat(db, { id: args.chatId, sessionId: args.sessionId });
  const subchatIndex = args.subchatIndex ?? 0;
  const state = await getLatestStorageState(db, {
    chatId: chat.id,
    subchatIndex,
    lastMessageRank: args.lastMessageRank,
  });
  if (!state?.storage_key) {
    throw new Error('Cannot rewind to a chat with no messages saved');
  }
  await db
    .prepare('UPDATE chats SET last_subchat_index = ?, last_message_rank = ? WHERE id = ?')
    .bind(subchatIndex, state.last_message_rank, chat.id)
    .run();
  return null;
}

export async function getSubchats(db: D1Database, args: { sessionId: string; chatId: string }) {
  const chat = await requireChat(db, { id: args.chatId, sessionId: args.sessionId });
  const { results } = await db
    .prepare(
      `SELECT subchat_index, description, MAX(created_at) AS updated_at
       FROM chat_message_states
       WHERE chat_id = ?
       GROUP BY subchat_index
       ORDER BY subchat_index ASC`,
    )
    .bind(chat.id)
    .all<{ subchat_index: number; description: string | null; updated_at: number }>();
  return results.map((row) => ({
    subchatIndex: row.subchat_index,
    description: row.description ?? undefined,
    updatedAt: row.updated_at,
  }));
}

export async function createSubchat(db: D1Database, args: { sessionId: string; chatId: string }): Promise<number> {
  const chat = await requireChat(db, { id: args.chatId, sessionId: args.sessionId });
  const newSubchatIndex = chat.last_subchat_index + 1;
  const latestState = await getLatestStorageState(db, { chatId: chat.id, subchatIndex: chat.last_subchat_index });
  await insertChatMessageState(db, {
    chatId: chat.id,
    subchatIndex: newSubchatIndex,
    lastMessageRank: -1,
    partIndex: -1,
    snapshotKey: latestState?.snapshot_key,
  });
  await db.prepare('UPDATE chats SET last_subchat_index = ? WHERE id = ?').bind(newSubchatIndex, chat.id).run();
  return newSubchatIndex;
}

export async function getSnapshotUrl(env: Env, args: { sessionId: string; chatId: string }): Promise<string | null> {
  const chat = await requireChat(env.DB, { id: args.chatId, sessionId: args.sessionId });
  const latestState = await getLatestStorageState(env.DB, {
    chatId: chat.id,
    subchatIndex: chat.last_subchat_index,
  });
  const key = latestState?.snapshot_key ?? chat.snapshot_key;
  return key ? storageUrl(key) : null;
}
