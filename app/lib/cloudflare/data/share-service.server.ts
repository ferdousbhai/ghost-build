import type { CurrentSocialShare, SocialShare } from '~/lib/cloudflare/data-api';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import {
  getLatestStorageState,
  insertChatWithState,
  requireChat,
  requireChatByPrimaryId,
} from './chat-repository.server';
import { deleteObject, putObject, storageUrl } from './object-storage.server';
import { prepareObjectGcCandidateStatements, sweepObjectGcCandidatesBestEffort } from './object-gc.server';
import type { ShareRow, SocialShareRow } from './types';

const logger = createScopedLogger('CloudflareShareStorage');
const MAX_SOCIAL_SHARE_WRITE_ATTEMPTS = 8;

export async function createShare(db: D1Database, args: { sessionId: string; id: string }) {
  const chat = await requireChat(db, { id: args.id, sessionId: args.sessionId });
  const state = await getLatestStorageState(db, { chatId: chat.id, subchatIndex: chat.last_subchat_index });
  const snapshotKey = state?.snapshot_key ?? chat.snapshot_key;
  if (!state?.storage_key) {
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

export async function getShareDescription(db: D1Database, args: { code: string }) {
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

export async function cloneShare(db: D1Database, args: { shareCode: string; sessionId: string }) {
  const share = await db.prepare('SELECT * FROM shares WHERE code = ?').bind(args.shareCode).first<ShareRow>();
  if (!share) {
    return cloneSocialShare(db, args.shareCode, args.sessionId);
  }
  if (!share.chat_history_key) {
    throw new Error('Chat history not found');
  }
  const parentChat = await requireChatByPrimaryId(
    db,
    share.chat_id,
    'The original chat was not found. It may have been deleted.',
  );
  return cloneChatFromState(db, {
    sessionId: args.sessionId,
    parentDescription: parentChat.description,
    storageKey: share.chat_history_key,
    subchatIndex: share.last_subchat_index,
    lastMessageRank: share.last_message_rank,
    partIndex: share.part_index ?? -1,
    snapshotKey: share.snapshot_key,
    stateDescription: share.description,
  });
}

export async function upsertSocialShare(
  db: D1Database,
  args: { sessionId: string; id: string; isShared: boolean },
): Promise<string> {
  const chat = await requireChat(db, { id: args.id, sessionId: args.sessionId });
  const share = await insertOrUpdateSocialShare(db, chat.id, args.isShared ? 1 : 0);
  return share.code;
}

export async function getCurrentSocialShare(
  db: D1Database,
  args: { sessionId: string; id: string },
): Promise<CurrentSocialShare | null> {
  const chat = await requireChat(db, { id: args.id, sessionId: args.sessionId });
  const share = await db.prepare('SELECT * FROM social_shares WHERE chat_id = ?').bind(chat.id).first<SocialShareRow>();
  if (!share) {
    return null;
  }
  return {
    isShared: Boolean(share.is_shared),
    code: share.code,
    thumbnailUrl: share.thumbnail_image_key ? storageUrl(share.thumbnail_image_key) : null,
  };
}

export async function getSocialShare(env: Env, code: string): Promise<SocialShare> {
  const share = await env.DB.prepare('SELECT * FROM social_shares WHERE code = ?').bind(code).first<SocialShareRow>();
  if (!share?.is_shared) {
    throw new Error('Invalid share link');
  }
  const chat = await requireChatByPrimaryId(env.DB, share.chat_id, 'Invalid chat');
  return {
    description: chat.description ?? null,
    code,
    thumbnailUrl: share.thumbnail_image_key ? storageUrl(share.thumbnail_image_key) : null,
  };
}

export async function saveThumbnail(
  env: Env,
  args: { sessionId: string; chatId: string; image: Blob },
): Promise<string> {
  const chat = await requireChat(env.DB, { id: args.chatId, sessionId: args.sessionId });
  const storageKey = await putObject(env, 'thumbnails', args.image);
  try {
    let current = await insertOrKeepSocialShare(env.DB, chat.id);
    for (let attempt = 0; attempt < MAX_SOCIAL_SHARE_WRITE_ATTEMPTS; attempt++) {
      const displacedKey = current.thumbnail_image_key !== storageKey ? current.thumbnail_image_key : null;
      const [update] = await env.DB.batch([
        env.DB.prepare(
          `UPDATE social_shares
           SET thumbnail_image_key = ?
           WHERE id = ? AND thumbnail_image_key IS ?`,
        ).bind(storageKey, current.id, current.thumbnail_image_key),
        ...prepareObjectGcCandidateStatements(env.DB, [displacedKey]),
      ]);
      if (update.meta.changes > 0) {
        await sweepObjectGcCandidatesBestEffort(env);
        return storageKey;
      }
      const latest = await env.DB.prepare('SELECT * FROM social_shares WHERE chat_id = ?')
        .bind(chat.id)
        .first<SocialShareRow>();
      if (!latest) {
        throw new Error('Social share disappeared during thumbnail save');
      }
      current = latest;
    }
    throw new Error('Social share changed too many times; retry the thumbnail save');
  } catch (error) {
    await deleteObjectBestEffort(env, storageKey);
    throw error;
  }
}

async function cloneSocialShare(db: D1Database, code: string, sessionId: string) {
  const socialShare = await db.prepare('SELECT * FROM social_shares WHERE code = ?').bind(code).first<SocialShareRow>();
  if (!socialShare) {
    throw new Error('Invalid share link');
  }
  if (!socialShare.is_shared) {
    throw new Error('This project is not allowed to be forked.');
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

  return cloneChatFromState(db, {
    sessionId,
    parentDescription: parentChat.description,
    storageKey: state.storage_key,
    subchatIndex: state.subchat_index,
    lastMessageRank: state.last_message_rank,
    partIndex: state.part_index,
    snapshotKey: state.snapshot_key ?? parentChat.snapshot_key,
    stateDescription: state.description,
  });
}

async function cloneChatFromState(
  db: D1Database,
  args: {
    sessionId: string;
    parentDescription: string | null;
    storageKey: string;
    subchatIndex: number;
    lastMessageRank: number;
    partIndex: number;
    snapshotKey: string | null;
    stateDescription: string | null;
  },
) {
  const initialId = crypto.randomUUID();
  const chatId = crypto.randomUUID();
  await insertChatWithState(
    db,
    {
      id: chatId,
      creatorId: args.sessionId,
      initialId,
      description: args.parentDescription,
      snapshotKey: args.snapshotKey,
      lastSubchatIndex: args.subchatIndex,
    },
    {
      storageKey: args.storageKey,
      subchatIndex: args.subchatIndex,
      lastMessageRank: args.lastMessageRank,
      partIndex: args.partIndex,
      snapshotKey: args.snapshotKey,
      description: args.stateDescription,
    },
  );
  return { id: initialId, description: args.parentDescription ?? undefined };
}

async function deleteObjectBestEffort(env: Env, key: string): Promise<void> {
  try {
    await deleteObject(env, key);
  } catch (error) {
    logger.warn('Unable to clean up uploaded thumbnail object', { key, error });
  }
}

async function insertOrUpdateSocialShare(db: D1Database, chatId: string, isShared: number): Promise<SocialShareRow> {
  return writeSocialShare(db, chatId, isShared, true);
}

async function insertOrKeepSocialShare(db: D1Database, chatId: string): Promise<SocialShareRow> {
  return writeSocialShare(db, chatId, 0, false);
}

async function writeSocialShare(
  db: D1Database,
  chatId: string,
  isShared: number,
  updateSharing: boolean,
): Promise<SocialShareRow> {
  for (let attempt = 0; attempt < MAX_SOCIAL_SHARE_WRITE_ATTEMPTS; attempt++) {
    const code = await generateUniqueCode(db);
    try {
      const share = await db
        .prepare(
          `INSERT INTO social_shares (id, chat_id, code, thumbnail_image_key, is_shared)
           VALUES (?, ?, ?, NULL, ?)
           ON CONFLICT(chat_id) DO UPDATE SET
             is_shared = CASE WHEN ? THEN excluded.is_shared ELSE social_shares.is_shared END
           RETURNING *`,
        )
        .bind(crypto.randomUUID(), chatId, code, isShared, updateSharing ? 1 : 0)
        .first<SocialShareRow>();
      if (share) {
        return share;
      }
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
    }
  }
  throw new Error('Unable to allocate a unique social share code');
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && /unique constraint failed/i.test(error.message);
}

async function generateUniqueCode(db: D1Database): Promise<string> {
  while (true) {
    const code = crypto.randomUUID().replace(/-/g, '').substring(0, 6);
    const existing = await db
      .prepare(
        `SELECT 1 AS found FROM shares WHERE code = ?
         UNION ALL
         SELECT 1 AS found FROM social_shares WHERE code = ?
         LIMIT 1`,
      )
      .bind(code, code)
      .first<{ found: number }>();
    if (!existing) {
      return code;
    }
  }
}
