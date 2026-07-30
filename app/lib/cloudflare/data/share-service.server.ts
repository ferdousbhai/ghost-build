import type { CurrentSocialShare, SocialShare } from '~/lib/cloudflare/data-api';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import {
  getLatestStorageState,
  insertChatWithState,
  requireChat,
  type ChatInsertAuthorization,
} from './chat-repository.server';
import {
  allocateCustomerObjectKey,
  allocateObjectKey,
  isCustomerObjectKey,
  objectResponse,
  putObjectAtKey,
  storageUrl,
} from './object-storage.server';
import {
  cancelObjectGcCandidate,
  prepareObjectGcCandidateStatements,
  queueObjectGcCandidate,
  sweepObjectGcCandidatesBestEffort,
} from './object-gc.server';
import type { ShareRow, SocialShareRow } from './types';
import { DataNotFoundError } from './errors';
import {
  type ChatBackupQuotaConfig,
  createChatBackupCloneQuotaExtension,
  enforceChatBackupEdgeRateLimit,
  registerMaterializedChatBackupObject,
  releaseChatBackupCloneAdmissionBestEffort,
  throwIfChatBackupCloneQuotaDenied,
} from './chat-backup-quota.server';
import {
  publishThumbnailReplacement,
  registerThumbnailUploadObject,
  reserveThumbnailReplacement,
  ThumbnailReservationStaleError,
  type ThumbnailUploadAdmission,
} from './thumbnail-quota.server';

const logger = createScopedLogger('CloudflareShareStorage');
const MAX_SOCIAL_SHARE_WRITE_ATTEMPTS = 8;
const SHARE_CODE_PATTERN = /^[a-f0-9]{32}$/;

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
  const shareId = crypto.randomUUID();
  let result: D1Result;
  try {
    result = await db
      .prepare(
        `INSERT INTO shares (
          id, chat_id, snapshot_key, code, chat_history_key, last_message_rank,
          last_subchat_index, part_index, description
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM chats
        WHERE id = ? AND creator_id = ? AND is_deleted = 0`,
      )
      .bind(
        shareId,
        chat.id,
        snapshotKey,
        code,
        state.storage_key,
        state.last_message_rank,
        chat.last_subchat_index,
        state.part_index,
        chat.description,
        chat.id,
        args.sessionId,
      )
      .run();
  } catch (error) {
    try {
      const committed = await db
        .prepare(
          `SELECT 1 AS found
           FROM shares
           JOIN chats ON chats.id = shares.chat_id
           WHERE shares.id = ? AND shares.chat_id = ? AND shares.code = ?
             AND shares.snapshot_key = ? AND shares.chat_history_key = ?
             AND shares.last_message_rank = ? AND shares.last_subchat_index = ?
             AND shares.part_index IS ? AND shares.description IS ?
             AND chats.creator_id = ? AND chats.is_deleted = 0
           LIMIT 1`,
        )
        .bind(
          shareId,
          chat.id,
          code,
          snapshotKey,
          state.storage_key,
          state.last_message_rank,
          chat.last_subchat_index,
          state.part_index,
          chat.description,
          args.sessionId,
        )
        .first<{ found: number }>();
      if (committed) {
        return { code };
      }
    } catch {
      // Preserve the original insert failure when the exact share receipt cannot be read.
    }
    throw error;
  }
  if (result.meta.changes !== 1) {
    throw new DataNotFoundError('Chat not found');
  }
  return { code };
}

export async function getShareDescription(db: D1Database, args: { code: string }) {
  requireStrongShareCode(args.code);
  const share = await db
    .prepare(
      `SELECT shares.description
       FROM shares
       JOIN chats ON chats.id = shares.chat_id
       WHERE shares.code = ? AND chats.is_deleted = 0`,
    )
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
       WHERE social_shares.code = ? AND social_shares.is_shared = 1 AND chats.is_deleted = 0`,
    )
    .bind(args.code)
    .first<{ description: string | null }>();
  if (!socialShare) {
    throw new DataNotFoundError('Invalid share link');
  }
  return { description: socialShare.description ?? undefined };
}

export async function cloneShare(
  env: Pick<Env, 'CHAT_BACKUP_RATE_LIMITER' | 'DB'> & ChatBackupQuotaConfig,
  args: { shareCode: string; sessionId: string },
) {
  const db = env.DB;
  requireStrongShareCode(args.shareCode);
  await enforceChatBackupEdgeRateLimit(env, args.sessionId);
  const share = await db
    .prepare(
      `SELECT shares.*, chats.description AS parent_description
       FROM shares
       JOIN chats ON chats.id = shares.chat_id
       WHERE shares.code = ? AND chats.is_deleted = 0`,
    )
    .bind(args.shareCode)
    .first<ShareRow & { parent_description: string | null }>();
  if (!share) {
    return cloneSocialShare(env, args.shareCode, args.sessionId);
  }
  if (!share.chat_history_key) {
    throw new Error('Chat history not found');
  }
  return cloneChatFromState(env, {
    sessionId: args.sessionId,
    parentDescription: share.parent_description,
    storageKey: share.chat_history_key,
    subchatIndex: share.last_subchat_index,
    lastMessageRank: share.last_message_rank,
    partIndex: share.part_index ?? -1,
    snapshotKey: share.snapshot_key,
    stateDescription: share.description,
    authorization: { kind: 'legacy-share', code: args.shareCode, parentChatId: share.chat_id },
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
  let share = await db.prepare('SELECT * FROM social_shares WHERE chat_id = ?').bind(chat.id).first<SocialShareRow>();
  if (!share) {
    return null;
  }
  if (!isStrongShareCode(share.code)) {
    share = await rotateSocialShareCode(db, share);
  }
  return {
    isShared: Boolean(share.is_shared),
    code: share.code,
    thumbnailUrl: share.thumbnail_image_key ? storageUrl(share.thumbnail_image_key) : null,
  };
}

export async function getSocialShare(env: Env, code: string): Promise<SocialShare> {
  requireStrongShareCode(code);
  const share = await env.DB.prepare(
    `SELECT social_shares.id, social_shares.chat_id, social_shares.code,
            social_shares.thumbnail_image_key, social_shares.is_shared,
            chats.description AS chat_description
     FROM social_shares
     JOIN chats ON chats.id = social_shares.chat_id
     WHERE social_shares.code = ? AND social_shares.is_shared = 1 AND chats.is_deleted = 0`,
  )
    .bind(code)
    .first<SocialShareRow & { chat_description: string | null }>();
  if (!share) {
    throw new DataNotFoundError('Invalid share link');
  }
  return {
    description: share.chat_description,
    code,
    thumbnailUrl: share.thumbnail_image_key ? storageUrl(share.thumbnail_image_key) : null,
  };
}

export async function saveThumbnail(
  env: Env,
  args: { admission: ThumbnailUploadAdmission; image: Blob },
): Promise<string> {
  let current = await insertOrKeepSocialShare(env.DB, args.admission.chatId);
  let admission = await reserveThumbnailReplacement(env.DB, args.admission, {
    sizeBytes: args.image.size,
    expectedStorageKey: current.thumbnail_image_key,
  });
  const storageKey = allocateObjectKey('thumbnails');
  const gcReceipt = await queueObjectGcCandidate(env.DB, storageKey);
  await registerThumbnailUploadObject(env.DB, {
    admission,
    storageKey,
    sizeBytes: args.image.size,
  });
  await putObjectAtKey(env, storageKey, args.image);
  for (let attempt = 0; attempt < MAX_SOCIAL_SHARE_WRITE_ATTEMPTS; attempt++) {
    const displacedKey = current.thumbnail_image_key !== storageKey ? current.thumbnail_image_key : null;
    const result = await publishThumbnailReplacement(env.DB, {
      admission,
      storageKey,
      sizeBytes: args.image.size,
      displacedStorageKey: displacedKey,
      gcStatements: prepareObjectGcCandidateStatements(env.DB, [displacedKey]),
    });
    if (result === 'published') {
      await cancelThumbnailGcCandidateBestEffort(env.DB, gcReceipt);
      await sweepObjectGcCandidatesBestEffort(env);
      return storageKey;
    }
    const latest = await env.DB.prepare('SELECT * FROM social_shares WHERE chat_id = ?')
      .bind(args.admission.chatId)
      .first<SocialShareRow>();
    if (!latest) {
      throw new Error('Social share disappeared during thumbnail save');
    }
    current = latest;
    try {
      admission = await reserveThumbnailReplacement(env.DB, admission, {
        sizeBytes: args.image.size,
        expectedStorageKey: current.thumbnail_image_key,
      });
    } catch (error) {
      if (error instanceof ThumbnailReservationStaleError) {
        continue;
      }
      throw error;
    }
  }
  throw new Error('Social share changed too many times; retry the thumbnail save');
}

async function cloneSocialShare(env: Pick<Env, 'DB'> & ChatBackupQuotaConfig, code: string, sessionId: string) {
  const db = env.DB;
  const socialShare = await db
    .prepare(
      `SELECT social_shares.id, social_shares.chat_id, social_shares.code,
              social_shares.thumbnail_image_key, social_shares.is_shared,
              chats.description AS chat_description,
              chats.last_subchat_index AS chat_last_subchat_index,
              chats.snapshot_key AS chat_snapshot_key
       FROM social_shares
       JOIN chats ON chats.id = social_shares.chat_id
       WHERE social_shares.code = ? AND social_shares.is_shared = 1 AND chats.is_deleted = 0`,
    )
    .bind(code)
    .first<
      SocialShareRow & {
        chat_description: string | null;
        chat_last_subchat_index: number;
        chat_snapshot_key: string | null;
      }
    >();
  if (!socialShare) {
    throw new DataNotFoundError('Invalid share link');
  }
  const state = await getLatestStorageState(db, {
    chatId: socialShare.chat_id,
    subchatIndex: socialShare.chat_last_subchat_index,
  });
  if (!state?.storage_key) {
    throw new Error('Chat history not found');
  }

  return cloneChatFromState(env, {
    sessionId,
    parentDescription: socialShare.chat_description,
    storageKey: state.storage_key,
    subchatIndex: state.subchat_index,
    lastMessageRank: state.last_message_rank,
    partIndex: state.part_index,
    snapshotKey: state.snapshot_key ?? socialShare.chat_snapshot_key,
    stateDescription: state.description,
    authorization: { kind: 'social-share', code, parentChatId: socialShare.chat_id },
  });
}

async function cloneChatFromState(
  env: Pick<Env, 'DB'> & ChatBackupQuotaConfig,
  args: {
    sessionId: string;
    parentDescription: string | null;
    storageKey: string;
    subchatIndex: number;
    lastMessageRank: number;
    partIndex: number;
    snapshotKey: string | null;
    stateDescription: string | null;
    authorization: ChatInsertAuthorization;
  },
) {
  const db = env.DB;
  const initialId = crypto.randomUUID();
  const chatId = crypto.randomUUID();
  const materialized = await materializeCustomerOwnedCloneObjects(env, {
    ownerId: args.sessionId,
    storageKey: args.storageKey,
    snapshotKey: args.snapshotKey,
  });
  const storageKeys = [materialized.storageKey, materialized.snapshotKey];
  const quota = createChatBackupCloneQuotaExtension(env, {
    ownerId: args.sessionId,
    chatId,
    storageKeys,
  });
  try {
    await insertChatWithState(
      db,
      {
        id: chatId,
        creatorId: args.sessionId,
        initialId,
        description: args.parentDescription,
        snapshotKey: materialized.snapshotKey,
        lastSubchatIndex: args.subchatIndex,
      },
      {
        storageKey: materialized.storageKey,
        subchatIndex: args.subchatIndex,
        lastMessageRank: args.lastMessageRank,
        partIndex: args.partIndex,
        snapshotKey: materialized.snapshotKey,
        description: args.stateDescription,
      },
      { ...args.authorization, quotaAdmissionId: quota.admissionId },
      quota,
    );
  } catch (error) {
    await releaseChatBackupCloneAdmissionBestEffort(db, {
      admissionId: quota.admissionId,
      ownerId: args.sessionId,
    });
    await throwIfChatBackupCloneQuotaDenied(env, {
      admissionId: quota.admissionId,
      ownerId: args.sessionId,
      storageKeys,
    });
    throw error;
  }
  await Promise.all(
    materialized.gcReceipts.map((receipt) =>
      cancelObjectGcCandidate(db, receipt).catch((error) => {
        logger.warn('Unable to cancel cloned backup cleanup receipt', { key: receipt.storageKey, error });
        return false;
      }),
    ),
  );
  return { id: initialId, description: args.parentDescription ?? undefined };
}

async function materializeCustomerOwnedCloneObjects(
  env: Pick<Env, 'DB'>,
  args: { ownerId: string; storageKey: string; snapshotKey: string | null },
): Promise<{
  storageKey: string;
  snapshotKey: string | null;
  gcReceipts: Array<Awaited<ReturnType<typeof queueObjectGcCandidate>>>;
}> {
  if (!isCustomerObjectKey(args.storageKey) && (!args.snapshotKey || !isCustomerObjectKey(args.snapshotKey))) {
    return { storageKey: args.storageKey, snapshotKey: args.snapshotKey, gcReceipts: [] };
  }
  const copied = await Promise.all([
    copyCloneObject(env, args.ownerId, args.storageKey, 'message-history'),
    args.snapshotKey ? copyCloneObject(env, args.ownerId, args.snapshotKey, 'snapshot') : null,
  ]);
  return {
    storageKey: copied[0].storageKey,
    snapshotKey: copied[1]?.storageKey ?? null,
    gcReceipts: copied.flatMap((object) => (object ? [object.gcReceipt] : [])),
  };
}

async function copyCloneObject(
  env: Pick<Env, 'DB'>,
  ownerId: string,
  sourceKey: string,
  kind: 'message-history' | 'snapshot',
): Promise<{
  storageKey: string;
  gcReceipt: Awaited<ReturnType<typeof queueObjectGcCandidate>>;
}> {
  const response = await objectResponse(env as Env, sourceKey);
  if (!response.ok) {
    throw new Error('Shared project backup is unavailable.');
  }
  const blob = await response.blob();
  const storageKey = allocateCustomerObjectKey(ownerId, kind === 'snapshot' ? 'snapshots' : 'message-history');
  const gcReceipt = await queueObjectGcCandidate(env.DB, storageKey);
  await registerMaterializedChatBackupObject(env.DB, {
    storageKey,
    sizeBytes: blob.size,
    kind,
  });
  await putObjectAtKey(env as Env, storageKey, blob);
  return { storageKey, gcReceipt };
}

async function cancelThumbnailGcCandidateBestEffort(
  db: D1Database,
  receipt: Awaited<ReturnType<typeof queueObjectGcCandidate>>,
): Promise<void> {
  try {
    await cancelObjectGcCandidate(db, receipt);
  } catch (error) {
    logger.warn('Unable to cancel live thumbnail cleanup receipt', { key: receipt.storageKey, error });
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
           SELECT ?, ?, ?, NULL, ?
           FROM chats
           WHERE id = ? AND is_deleted = 0
           ON CONFLICT(chat_id) DO UPDATE SET
             code = CASE
               WHEN length(social_shares.code) <> 32 OR social_shares.code GLOB '*[^0-9a-f]*'
                 OR (? AND social_shares.is_shared <> excluded.is_shared)
               THEN excluded.code
               ELSE social_shares.code
             END,
             is_shared = CASE WHEN ? THEN excluded.is_shared ELSE social_shares.is_shared END
           RETURNING *`,
        )
        .bind(crypto.randomUUID(), chatId, code, isShared, chatId, updateSharing ? 1 : 0, updateSharing ? 1 : 0)
        .first<SocialShareRow>();
      if (share) {
        return share;
      }
      throw new DataNotFoundError('Chat not found');
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
    const code = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
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

async function rotateSocialShareCode(db: D1Database, initial: SocialShareRow): Promise<SocialShareRow> {
  let share = initial;
  for (let attempt = 0; attempt < MAX_SOCIAL_SHARE_WRITE_ATTEMPTS; attempt++) {
    const code = await generateUniqueCode(db);
    try {
      const updated = await db
        .prepare('UPDATE social_shares SET code = ? WHERE id = ? AND code = ? RETURNING *')
        .bind(code, share.id, share.code)
        .first<SocialShareRow>();
      if (updated) {
        return updated;
      }
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
    }
    const current = await db.prepare('SELECT * FROM social_shares WHERE id = ?').bind(share.id).first<SocialShareRow>();
    if (!current) {
      throw new Error('Social share disappeared while rotating its code');
    }
    if (isStrongShareCode(current.code)) {
      return current;
    }
    share = current;
  }
  throw new Error('Unable to rotate an insecure social share code');
}

function requireStrongShareCode(code: string): void {
  if (!isStrongShareCode(code)) {
    throw new DataNotFoundError('Invalid share link');
  }
}

function isStrongShareCode(code: string): boolean {
  return SHARE_CODE_PATTERN.test(code);
}
