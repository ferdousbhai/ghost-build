import type { ChatMessageStateRow, ChatRow } from './types';
import { prepareObjectGcCandidateStatements } from './object-gc.server';

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
};

export async function insertChatMessageState(db: D1Database, args: ChatMessageStateInsertArgs): Promise<string> {
  const id = args.id ?? crypto.randomUUID();
  await prepareInsertChatMessageState(db, { ...args, id }).run();
  return id;
}

export async function insertChatWithState(
  db: D1Database,
  chat: ChatInsertArgs,
  state: Omit<ChatMessageStateInsertArgs, 'chatId'>,
): Promise<string> {
  const stateId = state.id ?? crypto.randomUUID();
  await db.batch([
    prepareInsertChat(db, chat),
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
        `INSERT INTO chat_message_states (
          id, chat_id, storage_key, subchat_index, last_message_rank, part_index,
          snapshot_key, description, created_at
        )
        SELECT ?, chats.id, NULL, 0, -1, -1, NULL, NULL, ?
        FROM chats
        WHERE chats.id = ? AND chats.creator_id = ? AND chats.initial_id = ? AND chats.is_deleted = 0
        ON CONFLICT(chat_id, subchat_index, last_message_rank) DO NOTHING`,
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
  if (args.lastMessageRank === undefined) {
    return db
      .prepare(
        `SELECT * FROM chat_message_states
         WHERE chat_id = ? AND subchat_index = ?
         ORDER BY last_message_rank DESC, part_index DESC
         LIMIT 1`,
      )
      .bind(args.chatId, args.subchatIndex)
      .first<ChatMessageStateRow>();
  }
  return db
    .prepare(
      `SELECT * FROM chat_message_states
       WHERE chat_id = ? AND subchat_index = ? AND last_message_rank <= ?
       ORDER BY last_message_rank DESC, part_index DESC
       LIMIT 1`,
    )
    .bind(args.chatId, args.subchatIndex, args.lastMessageRank)
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
  },
): Promise<{
  retainedStorageKey: boolean;
  retainedSnapshotKey: boolean;
  displacedKeys: string[];
}> {
  const chat = await requireChat(db, { id: args.chatId, sessionId: args.sessionId });
  for (let attempt = 0; attempt < MAX_STORAGE_UPDATE_CAS_ATTEMPTS; attempt++) {
    const previous = await getLatestStorageState(db, { chatId: chat.id, subchatIndex: args.subchatIndex });
    if (!previous) {
      throw new Error('Chat messages storage state not found');
    }
    if (previous.last_message_rank > args.lastMessageRank) {
      return rejectedStorageUpdate();
    }
    if (previous.last_message_rank === args.lastMessageRank && previous.part_index > args.partIndex) {
      await db
        .prepare('UPDATE chat_message_states SET description = COALESCE(description, ?) WHERE id = ?')
        .bind(args.initialDescription ?? null, previous.id)
        .run();
      return rejectedStorageUpdate();
    }
    if (previous.last_message_rank === args.lastMessageRank && previous.part_index === args.partIndex) {
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
        retainedStorageKey: false,
        retainedSnapshotKey: args.snapshotKey !== null && current?.snapshot_key === args.snapshotKey,
        displacedKeys: [],
      };
    }
    if (previous.last_message_rank === args.lastMessageRank) {
      const displaced = displacedKeys(previous, args);
      const [update] = await db.batch([
        db
          .prepare(
            `UPDATE chat_message_states
           SET storage_key = COALESCE(?, storage_key), part_index = ?,
               snapshot_key = COALESCE(?, snapshot_key), description = COALESCE(description, ?)
           WHERE id = ? AND last_message_rank = ? AND part_index = ?
             AND storage_key IS ? AND snapshot_key IS ?`,
          )
          .bind(
            args.storageKey,
            args.partIndex,
            args.snapshotKey,
            args.initialDescription ?? null,
            previous.id,
            previous.last_message_rank,
            previous.part_index,
            previous.storage_key,
            previous.snapshot_key,
          ),
        ...prepareObjectGcCandidateStatements(db, displaced),
      ]);
      if (update.meta.changes === 0) {
        continue;
      }
      return {
        retainedStorageKey: args.storageKey !== null,
        retainedSnapshotKey: args.snapshotKey !== null,
        displacedKeys: displaced,
      };
    }

    const stateId = crypto.randomUUID();
    const results = await db.batch([
      db
        .prepare(
          `INSERT INTO chat_message_states (
            id, chat_id, storage_key, subchat_index, last_message_rank, part_index,
            snapshot_key, description, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(chat_id, subchat_index, last_message_rank) DO NOTHING`,
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
        ),
      db
        .prepare('UPDATE chats SET last_message_rank = NULL, last_subchat_index = ? WHERE id = ?')
        .bind(args.subchatIndex, chat.id),
    ]);
    if (results[0].meta.changes === 0) {
      continue;
    }
    return {
      retainedStorageKey: args.storageKey !== null,
      retainedSnapshotKey: args.snapshotKey !== null,
      displacedKeys: [],
    };
  }
  throw new Error('Chat storage state changed too many times; retry the save');
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    );
}

function prepareInsertChatMessageState(db: D1Database, args: ChatMessageStateInsertArgs): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO chat_message_states (
        id, chat_id, storage_key, subchat_index, last_message_rank, part_index, snapshot_key, description, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    );
}

function getStorageStateById(db: D1Database, id: string): Promise<ChatMessageStateRow | null> {
  return db.prepare('SELECT * FROM chat_message_states WHERE id = ?').bind(id).first<ChatMessageStateRow>();
}

function rejectedStorageUpdate() {
  return {
    retainedStorageKey: false,
    retainedSnapshotKey: false,
    displacedKeys: [],
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
