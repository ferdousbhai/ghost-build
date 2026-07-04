import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { z } from 'zod';
import type {
  CurrentSocialShare,
  DataOperationArgs,
  DataOperationPath,
  DataOperationResult,
  SocialShare,
} from './data-api';
import { getAuth } from '~/lib/.server/auth';
import { dataOperationArgSchemas } from './data-operation-schemas';

const logger = createScopedLogger('CloudflareData');

const dataOperationPathSchema = z.enum(
  Object.keys(dataOperationArgSchemas) as [DataOperationPath, ...DataOperationPath[]],
);
const dataRequestSchema = z.object({
  path: dataOperationPathSchema,
  args: z.unknown(),
});
const chatRequestSchema = z.object({
  sessionId: z.string().min(1),
  chatId: z.string().min(1),
});
const storeChatRequestSchema = chatRequestSchema.extend({
  lastMessageRank: z.coerce.number().int().nonnegative(),
  lastSubchatIndex: z.coerce.number().int().nonnegative().default(0),
  partIndex: z.coerce.number().int().nonnegative(),
});
const initialMessagesRequestSchema = chatRequestSchema.extend({
  subchatIndex: z.number().int().nonnegative().optional(),
});

type DataOperationHandler<Path extends DataOperationPath> = (
  env: Env,
  args: DataOperationArgs<Path>,
) => DataOperationResult<Path> | Promise<DataOperationResult<Path>>;

type DataOperationHandlers = {
  [Path in DataOperationPath]: DataOperationHandler<Path>;
};

type ChatRow = {
  id: string;
  creator_id: string;
  initial_id: string;
  url_id: string | null;
  description: string | null;
  timestamp: string;
  snapshot_key: string | null;
  last_message_rank: number | null;
  last_subchat_index: number;
  is_deleted: number;
};

type ChatMessageStateRow = {
  id: string;
  chat_id: string;
  storage_key: string | null;
  subchat_index: number;
  last_message_rank: number;
  part_index: number;
  snapshot_key: string | null;
  description: string | null;
  created_at: number;
};

type ShareRow = {
  id: string;
  chat_id: string;
  snapshot_key: string;
  code: string;
  chat_history_key: string | null;
  last_message_rank: number;
  last_subchat_index: number;
  part_index: number | null;
  description: string | null;
};

type SocialShareRow = {
  id: string;
  chat_id: string;
  code: string;
  thumbnail_image_key: string | null;
  is_shared: number;
};

async function insertChat(
  db: D1Database,
  args: {
    id: string;
    creatorId: string;
    initialId: string;
    description?: string | null;
    snapshotKey?: string | null;
    lastSubchatIndex?: number;
  },
) {
  await db
    .prepare(
      `INSERT INTO chats (
        id, creator_id, initial_id, url_id, description, timestamp, snapshot_key,
        last_message_rank, last_subchat_index, is_deleted
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    )
    .run();
}

async function insertChatMessageState(
  db: D1Database,
  args: {
    chatId: string;
    storageKey?: string | null;
    subchatIndex: number;
    lastMessageRank: number;
    partIndex: number;
    snapshotKey?: string | null;
    description?: string | null;
  },
) {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO chat_message_states (
        id, chat_id, storage_key, subchat_index, last_message_rank, part_index, snapshot_key, description, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      args.chatId,
      args.storageKey ?? null,
      args.subchatIndex,
      args.lastMessageRank,
      args.partIndex,
      args.snapshotKey ?? null,
      args.description ?? null,
      Date.now(),
    )
    .run();
  return id;
}

export async function dataAction({ request, env }: { request: Request; env: Env }) {
  try {
    const body = dataRequestSchema.parse(await request.json());
    ensureDataBindings(env);
    const args = parseDataOperationArgs(body.path, body.args);
    await requireMatchingAuthenticatedSession(env, request, getSessionId(args));
    const result = await runKnownDataOperation(env, body.path, args);
    return Response.json({ result });
  } catch (error) {
    return internalErrorResponse(error, 'Unknown data error');
  }
}

export async function storeChatAction({ request, env }: { request: Request; env: Env }) {
  try {
    ensureDataBindings(env);
    const {
      sessionId,
      chatId,
      lastMessageRank,
      lastSubchatIndex: subchatIndex,
      partIndex,
    } = parseRequestQuery(request, storeChatRequestSchema);
    await requireMatchingAuthenticatedSession(env, request, sessionId);
    const formData = await request.formData();
    const messageBlob = formData.get('messages');
    const snapshotBlob = formData.get('snapshot');
    const storageKey = messageBlob instanceof Blob ? await putObject(env, 'message-history', messageBlob) : null;
    const snapshotKey = snapshotBlob instanceof Blob ? await putObject(env, 'snapshots', snapshotBlob) : null;

    const stateId = await updateStorageState(env.DB, {
      sessionId,
      chatId,
      storageKey,
      snapshotKey,
      lastMessageRank,
      subchatIndex,
      partIndex,
    });

    const firstMessage = formData.get('firstMessage');
    if (stateId && typeof firstMessage === 'string') {
      const chat = await findChat(env.DB, { id: chatId, sessionId });
      if (chat && !chat.description) {
        await env.DB.prepare('UPDATE chat_message_states SET description = ? WHERE id = ?')
          .bind(firstMessage.slice(0, 120), stateId)
          .run();
      }
    }

    return new Response(null, { status: 200 });
  } catch (error) {
    return internalErrorResponse(error, 'Unknown store_chat error');
  }
}

export async function initialMessagesAction({ request, env }: { request: Request; env: Env }) {
  try {
    ensureDataBindings(env);
    const body = initialMessagesRequestSchema.parse(await request.json());
    await requireMatchingAuthenticatedSession(env, request, body.sessionId);
    const chat = await findChat(env.DB, { id: body.chatId, sessionId: body.sessionId });
    if (!chat) {
      return new Response(`Chat not found: ${body.chatId}`, { status: 404 });
    }
    const state = await getLatestStorageState(env.DB, {
      chatId: chat.id,
      subchatIndex: body.subchatIndex ?? 0,
      lastMessageRank: chat.last_message_rank ?? undefined,
    });
    if (!state?.storage_key) {
      return new Response(null, { status: 204 });
    }
    return objectResponse(env, state.storage_key);
  } catch (error) {
    return internalErrorResponse(error, 'Unknown initial_messages error');
  }
}

export async function uploadSnapshotAction({ request, env }: { request: Request; env: Env }) {
  try {
    ensureDataBindings(env);
    const { sessionId, chatId } = parseRequestQuery(request, chatRequestSchema);
    await requireMatchingAuthenticatedSession(env, request, sessionId);
    const snapshotKey = await putObject(env, 'snapshots', await request.blob());
    const chat = await findChat(env.DB, { id: chatId, sessionId });
    if (!chat) {
      return Response.json({ error: 'Chat not found' }, { status: 404 });
    }
    await env.DB.prepare('UPDATE chats SET snapshot_key = ? WHERE id = ?').bind(snapshotKey, chat.id).run();
    return Response.json({ snapshotId: snapshotKey });
  } catch (error) {
    return internalErrorResponse(error, 'Unknown upload_snapshot error');
  }
}

export async function uploadThumbnailAction({ request, env }: { request: Request; env: Env }) {
  try {
    ensureDataBindings(env);
    const { sessionId, chatId } = parseRequestQuery(request, chatRequestSchema);
    await requireMatchingAuthenticatedSession(env, request, sessionId);
    const imageBlob = await request.blob();
    if (!imageBlob.type.startsWith('image/')) {
      return Response.json({ error: 'Invalid file type. Only images are allowed.' }, { status: 400 });
    }
    if (imageBlob.size > 5 * 1024 * 1024) {
      return Response.json({ error: 'Thumbnail image exceeds maximum size of 5MB' }, { status: 413 });
    }
    const chat = await findChat(env.DB, { id: chatId, sessionId });
    if (!chat) {
      return Response.json({ error: 'Chat not found' }, { status: 404 });
    }
    const storageKey = await putObject(env, 'thumbnails', imageBlob);
    const existing = await env.DB.prepare('SELECT * FROM social_shares WHERE chat_id = ?')
      .bind(chat.id)
      .first<SocialShareRow>();
    if (existing) {
      await env.DB.prepare('UPDATE social_shares SET thumbnail_image_key = ? WHERE id = ?')
        .bind(storageKey, existing.id)
        .run();
    } else {
      await env.DB.prepare(
        `INSERT INTO social_shares (
          id, chat_id, code, thumbnail_image_key, is_shared
        ) VALUES (?, ?, ?, ?, ?)`,
      )
        .bind(crypto.randomUUID(), chat.id, await generateUniqueCode(env.DB), storageKey, 0)
        .run();
    }
    return Response.json({ storageId: storageKey });
  } catch (error) {
    return internalErrorResponse(error, 'Unknown upload_thumbnail error');
  }
}

export function storageObjectAction({ key, env }: { key: string; env: Env }) {
  return objectResponse(env, decodeURIComponent(key));
}

function internalErrorResponse(error: unknown, fallback: string) {
  if (error instanceof z.ZodError) {
    return Response.json({ error: 'Invalid request', issues: error.issues }, { status: 400 });
  }
  if (error instanceof UnauthorizedError) {
    return Response.json({ error: error.message }, { status: 401 });
  }
  logger.error(error);
  return Response.json({ error: error instanceof Error ? error.message : fallback }, { status: 500 });
}

function ensureDataBindings(env: Env) {
  if (!env.DB) {
    throw new Error('Cloudflare D1 binding DB is not configured');
  }
  if (!env.APP_STORAGE) {
    throw new Error('Cloudflare R2 binding APP_STORAGE is not configured');
  }
}

function parseDataOperationArgs<Path extends DataOperationPath>(path: Path, args: unknown): DataOperationArgs<Path> {
  return dataOperationArgSchemas[path].parse(args) as DataOperationArgs<Path>;
}

const dataOperationHandlers = {
  'messages.initializeChat': (env, args) => initializeChat(env.DB, args),
  'messages.get': (env, args) => getChat(env.DB, args),
  'messages.getAll': (env, args) => getAllChats(env.DB, args),
  'messages.setUrlId': (env, args) => setUrlId(env.DB, args),
  'messages.setDescription': (env, args) => setDescription(env.DB, args),
  'messages.remove': (env, args) => removeChat(env.DB, args),
  'messages.earliestRewindableMessageRank': (env, args) => earliestRewindableMessageRank(env.DB, args),
  'messages.rewindChat': (env, args) => rewindChat(env.DB, args),
  'subchats.get': (env, args) => getSubchats(env.DB, args),
  'subchats.create': (env, args) => createSubchat(env.DB, args),
  'snapshot.getSnapshotUrl': (env, args) => getSnapshotUrl(env, args),
  'share.create': (env, args) => createShare(env.DB, args),
  'share.getShareDescription': (env, args) => getShareDescription(env.DB, args),
  'share.clone': (env, args) => cloneShare(env.DB, args),
  'socialShare.share': (env, args) => upsertSocialShare(env.DB, args),
  'socialShare.getCurrentSocialShare': (env, args) => getCurrentSocialShare(env.DB, args),
  'socialShare.getSocialShare': (env, args) => getSocialShare(env, args.code),
} satisfies DataOperationHandlers;

async function runKnownDataOperation<Path extends DataOperationPath>(
  env: Env,
  path: Path,
  args: DataOperationArgs<Path>,
): Promise<DataOperationResult<Path>> {
  const handler = dataOperationHandlers[path] as unknown as DataOperationHandler<Path>;
  return handler(env, args);
}

class UnauthorizedError extends Error {
  constructor() {
    super('Unauthorized');
  }
}

function getSessionId(args: unknown) {
  if (args && typeof args === 'object' && 'sessionId' in args && typeof args.sessionId === 'string') {
    return args.sessionId;
  }
  return null;
}

async function requireMatchingAuthenticatedSession(env: Env, request: Request, sessionId: string | null) {
  if (!sessionId) {
    return;
  }

  const session = await getAuth(env, request).api.getSession({ headers: request.headers });
  if (!session || session.user.id !== sessionId) {
    throw new UnauthorizedError();
  }
}

async function initializeChat(db: D1Database, args: { sessionId: string; id: string }) {
  const existing = await findChat(db, { id: args.id, sessionId: args.sessionId });
  if (existing) {
    return null;
  }
  const chatId = crypto.randomUUID();
  await insertChat(db, { id: chatId, creatorId: args.sessionId, initialId: args.id });
  await insertChatMessageState(db, { chatId, subchatIndex: 0, lastMessageRank: -1, partIndex: -1 });
  return null;
}

async function getChat(db: D1Database, args: { id: string; sessionId: string }) {
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

async function getAllChats(db: D1Database, args: { sessionId: string }) {
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

async function setUrlId(
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

async function setDescription(db: D1Database, args: { sessionId: string; id: string; description: string }) {
  const chat = await requireChat(db, { id: args.id, sessionId: args.sessionId });
  await db.prepare('UPDATE chats SET description = ? WHERE id = ?').bind(args.description, chat.id).run();
  return null;
}

async function removeChat(db: D1Database, args: { sessionId: string; id: string }) {
  const chat = await findChat(db, { id: args.id, sessionId: args.sessionId });
  if (chat) {
    await db.prepare('UPDATE chats SET is_deleted = 1 WHERE id = ?').bind(chat.id).run();
  }
  return { kind: 'success' } as const;
}

async function earliestRewindableMessageRank(
  db: D1Database,
  args: { sessionId: string; chatId: string; subchatIndex?: number },
) {
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

async function rewindChat(
  db: D1Database,
  args: { sessionId: string; chatId: string; subchatIndex?: number; lastMessageRank?: number },
) {
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

async function getSubchats(db: D1Database, args: { sessionId: string; chatId: string }) {
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

async function createSubchat(db: D1Database, args: { sessionId: string; chatId: string }) {
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

async function getSnapshotUrl(env: Env, args: { sessionId: string; chatId: string }) {
  const chat = await requireChat(env.DB, { id: args.chatId, sessionId: args.sessionId });
  const latestState = await getLatestStorageState(env.DB, {
    chatId: chat.id,
    subchatIndex: chat.last_subchat_index,
  });
  const key = latestState?.snapshot_key ?? chat.snapshot_key;
  return key ? storageUrl(key) : null;
}

async function createShare(db: D1Database, args: { sessionId: string; id: string }) {
  const chat = await requireChat(db, { id: args.id, sessionId: args.sessionId });
  const state = await getLatestStorageState(db, { chatId: chat.id, subchatIndex: chat.last_subchat_index });
  const snapshotKey = state?.snapshot_key ?? chat.snapshot_key;
  if (!state || (!state.storage_key && chat.last_subchat_index === 0)) {
    throw new Error('Chat history not found');
  }
  if (!snapshotKey) {
    throw new Error('Your project has never been saved.');
  }
  const code = await generateUniqueCode(db);
  await db
    .prepare(
      `INSERT INTO shares (
        id, chat_id, snapshot_key, code, chat_history_key, last_message_rank,
        last_subchat_index, part_index, description
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      chat.id,
      snapshotKey,
      code,
      state.storage_key,
      state.last_message_rank,
      chat.last_subchat_index,
      state.part_index,
      chat.description,
    )
    .run();
  return { code };
}

async function getShareDescription(db: D1Database, args: { code: string }) {
  const share = await db
    .prepare('SELECT description FROM shares WHERE code = ?')
    .bind(args.code)
    .first<{ description: string | null }>();
  if (share) {
    return { description: share.description ?? undefined };
  }
  const socialShare = await db
    .prepare(
      `SELECT chats.description
       FROM social_shares
       JOIN chats ON chats.id = social_shares.chat_id
       WHERE social_shares.code = ?`,
    )
    .bind(args.code)
    .first<{ description: string | null }>();
  if (!socialShare) {
    throw new Error('Invalid share link');
  }
  return { description: socialShare.description ?? undefined };
}

async function cloneShare(db: D1Database, args: { shareCode: string; sessionId: string }) {
  const share = await db.prepare('SELECT * FROM shares WHERE code = ?').bind(args.shareCode).first<ShareRow>();
  if (!share) {
    return cloneSocialShare(db, args.shareCode, args.sessionId);
  }
  const parentChat = await requireChatByPrimaryId(
    db,
    share.chat_id,
    'The original chat was not found. It may have been deleted.',
  );
  const chatId = crypto.randomUUID();
  const initialId = crypto.randomUUID();
  await insertChat(db, {
    id: chatId,
    creatorId: args.sessionId,
    initialId,
    description: parentChat.description,
    snapshotKey: share.snapshot_key,
    lastSubchatIndex: share.last_subchat_index,
  });
  await insertChatMessageState(db, {
    chatId,
    storageKey: share.chat_history_key,
    subchatIndex: share.last_subchat_index,
    lastMessageRank: share.last_message_rank,
    partIndex: share.part_index ?? -1,
    snapshotKey: share.snapshot_key,
    description: share.description,
  });
  return { id: initialId, description: parentChat.description ?? undefined };
}

async function cloneSocialShare(db: D1Database, code: string, sessionId: string) {
  const socialShare = await db.prepare('SELECT * FROM social_shares WHERE code = ?').bind(code).first<SocialShareRow>();
  if (!socialShare) {
    throw new Error('Invalid share link');
  }
  if (!socialShare.is_shared) {
    throw new Error('This show is not allowed to be forked.');
  }
  const parentChat = await requireChatByPrimaryId(
    db,
    socialShare.chat_id,
    'The original chat was not found. It may have been deleted.',
  );
  const state = await getLatestStorageState(db, { chatId: parentChat.id, subchatIndex: parentChat.last_subchat_index });
  if (!state?.storage_key) {
    throw new Error('Chat history not found');
  }
  const initialId = crypto.randomUUID();
  const chatId = crypto.randomUUID();
  await insertChat(db, {
    id: chatId,
    creatorId: sessionId,
    initialId,
    description: parentChat.description,
    snapshotKey: state.snapshot_key ?? parentChat.snapshot_key,
    lastSubchatIndex: parentChat.last_subchat_index,
  });
  await insertChatMessageState(db, {
    chatId,
    storageKey: state.storage_key,
    subchatIndex: state.subchat_index,
    lastMessageRank: state.last_message_rank,
    partIndex: state.part_index,
    snapshotKey: state.snapshot_key,
    description: state.description,
  });
  return { id: initialId, description: parentChat.description ?? undefined };
}

async function upsertSocialShare(
  db: D1Database,
  args: {
    sessionId: string;
    id: string;
    isShared: boolean;
  },
) {
  const chat = await requireChat(db, { id: args.id, sessionId: args.sessionId });
  const existing = await db
    .prepare('SELECT * FROM social_shares WHERE chat_id = ?')
    .bind(chat.id)
    .first<SocialShareRow>();
  if (existing) {
    await db
      .prepare(
        `UPDATE social_shares
         SET is_shared = ?
         WHERE id = ?`,
      )
      .bind(args.isShared ? 1 : 0, existing.id)
      .run();
    return existing.code;
  }
  const code = await generateUniqueCode(db);
  await db
    .prepare(
      `INSERT INTO social_shares (
        id, chat_id, code, thumbnail_image_key, is_shared
      ) VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(crypto.randomUUID(), chat.id, code, null, args.isShared ? 1 : 0)
    .run();
  return code;
}

async function getCurrentSocialShare(db: D1Database, args: { sessionId: string; id: string }) {
  const chat = await requireChat(db, { id: args.id, sessionId: args.sessionId });
  const share = await db.prepare('SELECT * FROM social_shares WHERE chat_id = ?').bind(chat.id).first<SocialShareRow>();
  if (!share) {
    return null;
  }
  return {
    isShared: !!share.is_shared,
    code: share.code,
    thumbnailUrl: share.thumbnail_image_key ? storageUrl(share.thumbnail_image_key) : null,
  } satisfies CurrentSocialShare;
}

async function getSocialShare(env: Env, code: string) {
  const share = await env.DB.prepare('SELECT * FROM social_shares WHERE code = ?').bind(code).first<SocialShareRow>();
  if (!share?.is_shared) {
    throw new Error('Invalid share link');
  }
  const chat = await requireChatByPrimaryId(env.DB, share.chat_id, 'Invalid chat');
  return {
    description: chat.description ?? null,
    code,
    thumbnailUrl: share.thumbnail_image_key ? storageUrl(share.thumbnail_image_key) : null,
  } satisfies SocialShare;
}

async function updateStorageState(
  db: D1Database,
  args: {
    sessionId: string;
    chatId: string;
    storageKey: string | null;
    snapshotKey: string | null;
    lastMessageRank: number;
    subchatIndex: number;
    partIndex: number;
  },
) {
  const chat = await requireChat(db, { id: args.chatId, sessionId: args.sessionId });
  const previous = await getLatestStorageState(db, { chatId: chat.id, subchatIndex: args.subchatIndex });
  if (!previous) {
    throw new Error('Chat messages storage state not found');
  }
  if (previous.last_message_rank > args.lastMessageRank) {
    return null;
  }
  if (previous.last_message_rank === args.lastMessageRank && previous.part_index >= args.partIndex) {
    if (args.snapshotKey && !previous.snapshot_key) {
      await db
        .prepare('UPDATE chat_message_states SET snapshot_key = ? WHERE id = ?')
        .bind(args.snapshotKey, previous.id)
        .run();
    }
    return null;
  }
  if (previous.last_message_rank === args.lastMessageRank) {
    await db
      .prepare(
        `UPDATE chat_message_states
         SET storage_key = ?, part_index = ?, snapshot_key = COALESCE(?, snapshot_key)
         WHERE id = ?`,
      )
      .bind(args.storageKey, args.partIndex, args.snapshotKey, previous.id)
      .run();
    return null;
  }
  const stateId = await insertChatMessageState(db, {
    chatId: chat.id,
    storageKey: args.storageKey,
    subchatIndex: args.subchatIndex,
    lastMessageRank: args.lastMessageRank,
    partIndex: args.partIndex,
    snapshotKey: args.snapshotKey ?? previous.snapshot_key,
    description: previous.description,
  });
  await db
    .prepare('UPDATE chats SET last_message_rank = NULL, last_subchat_index = ? WHERE id = ?')
    .bind(args.subchatIndex, chat.id)
    .run();
  return previous.description === null ? stateId : null;
}

async function findChat(db: D1Database, args: { id: string; sessionId: string }) {
  return db
    .prepare(
      `SELECT * FROM chats
       WHERE creator_id = ? AND (initial_id = ? OR url_id = ?) AND is_deleted = 0
       LIMIT 1`,
    )
    .bind(args.sessionId, args.id, args.id)
    .first<ChatRow>();
}

async function requireChat(db: D1Database, args: { id: string; sessionId: string }) {
  const chat = await findChat(db, args);
  if (!chat) {
    throw new Error('Chat not found');
  }
  return chat;
}

async function requireChatByPrimaryId(db: D1Database, id: string, errorMessage: string) {
  const chat = await db.prepare('SELECT * FROM chats WHERE id = ?').bind(id).first<ChatRow>();
  if (!chat) {
    throw new Error(errorMessage);
  }
  return chat;
}

async function allocateUrlId(db: D1Database, sessionId: string, urlHint: string) {
  const base = slugify(urlHint);
  let candidate = base;
  let index = 2;
  while (await findChat(db, { id: candidate, sessionId })) {
    candidate = `${base}-${index}`;
    index++;
  }
  return candidate;
}

function slugify(value: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || crypto.randomUUID().slice(0, 8);
}

function getLatestStorageState(
  db: D1Database,
  args: { chatId: string; subchatIndex: number; lastMessageRank?: number },
) {
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

async function generateUniqueCode(db: D1Database): Promise<string> {
  while (true) {
    const code = crypto.randomUUID().replace(/-/g, '').substring(0, 6);
    const existingShare = await db.prepare('SELECT id FROM shares WHERE code = ?').bind(code).first<{ id: string }>();
    const existingSocialShare = await db
      .prepare('SELECT id FROM social_shares WHERE code = ?')
      .bind(code)
      .first<{ id: string }>();
    if (!existingShare && !existingSocialShare) {
      return code;
    }
  }
}

async function putObject(env: Env, prefix: string, blob: Blob) {
  const key = `${prefix}/${crypto.randomUUID()}`;
  await env.APP_STORAGE.put(key, await blob.arrayBuffer(), {
    httpMetadata: {
      contentType: blob.type || 'application/octet-stream',
    },
  });
  return key;
}

async function objectResponse(env: Env, key: string) {
  const object = await env.APP_STORAGE.get(key);
  if (!object) {
    return new Response('Not found', { status: 404 });
  }
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  return new Response(object.body, { headers });
}

function storageUrl(key: string) {
  return `/api/storage/${encodeURIComponent(key)}`;
}

function parseRequestQuery<Schema extends z.ZodType>(request: Request, schema: Schema): z.output<Schema> {
  return schema.parse(Object.fromEntries(new URL(request.url).searchParams));
}
