import { transcriptAgentName } from 'ghostbuild-agent/transcript';
import type { ChatRow } from './types';
import { DataNotFoundError } from './errors';
import { prepareInsertChatTranscript } from './transcript-repository.server';
import {
  type UpdateStorageStateArgs,
  type UpdateStorageStateResult,
  updateStorageStateWithChatLookup,
} from './chat-storage-state-repository.server';

export {
  enforceChatStorageRetention,
  getLatestStorageState,
  getLatestStorageStateForGeneration,
  MAX_RETAINED_CHAT_STORAGE_STATES,
} from './chat-storage-state-repository.server';

type ChatInsertArgs = {
  id: string;
  creatorId: string;
  initialId: string;
  description?: string | null;
  snapshotKey?: string | null;
  lastSubchatIndex?: number;
};

export type ChatInsertAuthorization =
  | { kind: 'legacy-share'; code: string; parentChatId: string; quotaAdmissionId?: string }
  | { kind: 'social-share'; code: string; parentChatId: string; quotaAdmissionId?: string };

type ChatInsertTransactionExtension = {
  prefixStatements: D1PreparedStatement[];
  suffixStatements: D1PreparedStatement[];
  validateResults: (prefixResults: D1Result[], suffixResults: D1Result[]) => boolean;
  verifyReceipt: () => Promise<boolean>;
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
  authorization?: ChatInsertAuthorization,
  transaction?: ChatInsertTransactionExtension,
): Promise<string> {
  const stateId = state.id ?? crypto.randomUUID();
  const transitionToken = crypto.randomUUID();
  let results: D1Result[];
  try {
    results = await db.batch([
      ...(transaction?.prefixStatements ?? []),
      prepareInsertChat(db, chat, false, authorization),
      prepareInsertChatTranscript(db, {
        chatId: chat.id,
        initialId: chat.initialId,
        ownerId: chat.creatorId,
        subchatIndex: state.subchatIndex,
        generation: state.transcriptGeneration,
        headRevision: state.transcriptRevision,
        headDigest: state.transcriptDigest,
        transitionToken,
      }),
      prepareInsertChatMessageState(db, { ...state, id: stateId, chatId: chat.id }, chat.creatorId),
      ...(transaction?.suffixStatements ?? []),
    ]);
  } catch (error) {
    try {
      const generation = state.transcriptGeneration ?? 0;
      const revision = state.transcriptRevision ?? 0;
      const digest = state.transcriptDigest ?? null;
      const committed = await db
        .prepare(
          `SELECT 1 AS found
           FROM chats
           JOIN chat_transcripts AS transcripts
             ON transcripts.chat_id = chats.id AND transcripts.subchat_index = ?
           JOIN chat_message_states AS states
             ON states.chat_id = chats.id AND states.id = ?
           WHERE chats.id = ? AND chats.creator_id = ? AND chats.initial_id = ? AND chats.is_deleted = 0
             AND chats.url_id IS NULL AND chats.description IS ? AND chats.snapshot_key IS ?
             AND chats.last_message_rank IS NULL AND chats.last_subchat_index = ?
             AND transcripts.generation = ? AND transcripts.agent_name = ?
             AND transcripts.head_revision = ? AND transcripts.head_digest IS ?
             AND transcripts.head_message_count = 0 AND transcripts.parent_subchat_index IS NULL
             AND transcripts.parent_generation IS NULL AND transcripts.parent_revision IS NULL
             AND transcripts.transition_token = ?
             AND states.storage_key IS ? AND states.subchat_index = ?
             AND states.last_message_rank = ? AND states.part_index = ?
             AND states.snapshot_key IS ? AND states.description IS ?
             AND states.transcript_generation = ? AND states.transcript_revision = ?
             AND states.transcript_digest IS ?
           LIMIT 1`,
        )
        .bind(
          state.subchatIndex,
          stateId,
          chat.id,
          chat.creatorId,
          chat.initialId,
          chat.description ?? null,
          chat.snapshotKey ?? null,
          chat.lastSubchatIndex ?? 0,
          generation,
          transcriptAgentName(chat.initialId, state.subchatIndex, generation),
          revision,
          digest,
          transitionToken,
          state.storageKey ?? null,
          state.subchatIndex,
          state.lastMessageRank,
          state.partIndex,
          state.snapshotKey ?? null,
          state.description ?? null,
          generation,
          revision,
          digest,
        )
        .first<{ found: number }>();
      if (committed && (!transaction || (await transaction.verifyReceipt()))) {
        return stateId;
      }
    } catch {
      // Preserve the original batch failure when the exact insert receipt cannot be read.
    }
    throw error;
  }
  const prefixCount = transaction?.prefixStatements.length ?? 0;
  const coreResults = results.slice(prefixCount, prefixCount + 3);
  const suffixResults = results.slice(prefixCount + 3);
  const extensionValid = !transaction || transaction.validateResults(results.slice(0, prefixCount), suffixResults);
  if (coreResults.some((result) => result.meta.changes !== 1) || !extensionValid) {
    if (authorization) {
      throw new DataNotFoundError('Invalid share link');
    }
    throw new Error('Unable to create chat');
  }
  return stateId;
}

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
  return { ...chat, created: results[0].meta.changes > 0 };
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
    throw new DataNotFoundError('Chat not found');
  }
  return chat;
}

export function updateStorageState(db: D1Database, args: UpdateStorageStateArgs): Promise<UpdateStorageStateResult> {
  return updateStorageStateWithChatLookup(db, args, requireChat);
}

function prepareInsertChat(
  db: D1Database,
  args: ChatInsertArgs,
  ignoreInitialConflict = false,
  authorization?: ChatInsertAuthorization,
): D1PreparedStatement {
  const authorizationSql =
    authorization?.kind === 'legacy-share'
      ? `AND EXISTS (
           SELECT 1 FROM shares
           JOIN chats AS parent_chat ON parent_chat.id = shares.chat_id
           WHERE shares.code = ? AND shares.chat_id = ? AND parent_chat.is_deleted = 0
         )`
      : authorization?.kind === 'social-share'
        ? `AND EXISTS (
             SELECT 1 FROM social_shares
             JOIN chats AS parent_chat ON parent_chat.id = social_shares.chat_id
             WHERE social_shares.code = ? AND social_shares.chat_id = ?
               AND social_shares.is_shared = 1 AND parent_chat.is_deleted = 0
           )`
        : '';
  const quotaAuthorizationSql = authorization?.quotaAdmissionId
    ? `AND EXISTS (
         SELECT 1 FROM chat_backup_admissions
         WHERE id = ? AND owner_id = ? AND chat_id = ? AND status = 'pending'
       )`
    : '';
  return db
    .prepare(
      `INSERT INTO chats (
        id, creator_id, initial_id, url_id, description, timestamp, snapshot_key,
        last_message_rank, last_subchat_index, is_deleted
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM chats WHERE initial_id = ?)
      ${authorizationSql}
      ${quotaAuthorizationSql}
      ${ignoreInitialConflict ? 'ON CONFLICT DO NOTHING' : ''}`,
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
      ...(authorization ? [authorization.code, authorization.parentChatId] : []),
      ...(authorization?.quotaAdmissionId ? [authorization.quotaAdmissionId, args.creatorId, args.id] : []),
    );
}

function prepareInsertChatMessageState(
  db: D1Database,
  args: ChatMessageStateInsertArgs,
  ownerId: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO chat_message_states (
        id, chat_id, storage_key, subchat_index, last_message_rank, part_index, snapshot_key, description, created_at,
        transcript_generation, transcript_revision, transcript_digest
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      FROM chats
      WHERE chats.id = ? AND chats.creator_id = ? AND chats.is_deleted = 0`,
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
      args.chatId,
      ownerId,
    );
}
