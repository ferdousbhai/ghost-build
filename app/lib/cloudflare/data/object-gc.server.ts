import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { deleteObject } from './object-storage.server';
import {
  prepareReleaseChatBackupAttributionsStatement,
  prepareReleaseChatBackupObjectStatement,
  releaseUnreferencedChatBackupAttributions,
} from './chat-backup-quota.server';
import { prepareReleaseThumbnailObjectStatement } from './thumbnail-quota.server';

export const OBJECT_GC_GRACE_PERIOD_MS = 5 * 60 * 1000;
export const OBJECT_GC_SWEEP_LIMIT = 8;
// The deployment build Workflow step is bounded to one hour. Preserve a live
// build across that full window plus a five-minute scheduling/commit grace period,
// then let the durable candidate collect it even if the Workflow hard-stops.
export const DEPLOYMENT_BUILD_ARTIFACT_LEASE_MS = 65 * 60 * 1000;

const logger = createScopedLogger('CloudflareObjectGc');

type ObjectGcCandidateRow = {
  storage_key: string;
  not_before: number;
};

type ObjectGcCandidateReceipt = {
  storageKey: string;
  notBefore: number;
};

export function prepareObjectGcCandidateStatements(
  db: D1Database,
  keys: Array<string | null>,
  now = Date.now(),
): D1PreparedStatement[] {
  const notBefore = now + OBJECT_GC_GRACE_PERIOD_MS;
  return uniqueKeys(keys).map((key) =>
    db
      .prepare(
        `INSERT INTO object_gc_candidates (storage_key, not_before, created_at, attempts)
         VALUES (?, ?, ?, 0)
         ON CONFLICT(storage_key) DO UPDATE SET
           not_before = MAX(object_gc_candidates.not_before, excluded.not_before)`,
      )
      .bind(key, notBefore, now),
  );
}

export async function queueObjectGcCandidate(
  db: D1Database,
  key: string,
  now = Date.now(),
): Promise<ObjectGcCandidateReceipt> {
  const notBefore = now + OBJECT_GC_GRACE_PERIOD_MS;
  await Promise.all(prepareObjectGcCandidateStatements(db, [key], now).map((statement) => statement.run()));
  return { storageKey: key, notBefore };
}

export async function cancelObjectGcCandidate(db: D1Database, receipt: ObjectGcCandidateReceipt): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM object_gc_candidates WHERE storage_key = ? AND not_before = ?')
    .bind(receipt.storageKey, receipt.notBefore)
    .run();
  return result.meta.changes === 1;
}

export function prepareChatObjectGcCandidateStatements(
  db: D1Database,
  args: { chatId: string; ownerId: string; now?: number },
): D1PreparedStatement[] {
  const now = args.now ?? Date.now();
  const notBefore = now + OBJECT_GC_GRACE_PERIOD_MS;

  // D1 rejects the equivalent six-way compound SELECT in production. Keep
  // every source in the same atomic batch while avoiding that query limit.
  return [
    db
      .prepare(
        `INSERT INTO object_gc_candidates (storage_key, not_before, created_at, attempts)
         SELECT snapshot_key, ?, ?, 0
         FROM chats
         WHERE id = ? AND creator_id = ? AND snapshot_key IS NOT NULL
         ON CONFLICT(storage_key) DO UPDATE SET
           not_before = MAX(object_gc_candidates.not_before, excluded.not_before)`,
      )
      .bind(notBefore, now, args.chatId, args.ownerId),
    db
      .prepare(
        `INSERT INTO object_gc_candidates (storage_key, not_before, created_at, attempts)
         SELECT storage_key, ?, ?, 0
         FROM chat_message_states
         WHERE chat_id = ? AND storage_key IS NOT NULL
         ON CONFLICT(storage_key) DO UPDATE SET
           not_before = MAX(object_gc_candidates.not_before, excluded.not_before)`,
      )
      .bind(notBefore, now, args.chatId),
    db
      .prepare(
        `INSERT INTO object_gc_candidates (storage_key, not_before, created_at, attempts)
         SELECT snapshot_key, ?, ?, 0
         FROM chat_message_states
         WHERE chat_id = ? AND snapshot_key IS NOT NULL
         ON CONFLICT(storage_key) DO UPDATE SET
           not_before = MAX(object_gc_candidates.not_before, excluded.not_before)`,
      )
      .bind(notBefore, now, args.chatId),
    db
      .prepare(
        `INSERT INTO object_gc_candidates (storage_key, not_before, created_at, attempts)
         SELECT chat_history_key, ?, ?, 0
         FROM shares
         WHERE chat_id = ? AND chat_history_key IS NOT NULL
         ON CONFLICT(storage_key) DO UPDATE SET
           not_before = MAX(object_gc_candidates.not_before, excluded.not_before)`,
      )
      .bind(notBefore, now, args.chatId),
    db
      .prepare(
        `INSERT INTO object_gc_candidates (storage_key, not_before, created_at, attempts)
         SELECT snapshot_key, ?, ?, 0
         FROM shares
         WHERE chat_id = ? AND snapshot_key IS NOT NULL
         ON CONFLICT(storage_key) DO UPDATE SET
           not_before = MAX(object_gc_candidates.not_before, excluded.not_before)`,
      )
      .bind(notBefore, now, args.chatId),
    db
      .prepare(
        `INSERT INTO object_gc_candidates (storage_key, not_before, created_at, attempts)
         SELECT thumbnail_image_key, ?, ?, 0
         FROM social_shares
         WHERE chat_id = ? AND thumbnail_image_key IS NOT NULL
         ON CONFLICT(storage_key) DO UPDATE SET
           not_before = MAX(object_gc_candidates.not_before, excluded.not_before)`,
      )
      .bind(notBefore, now, args.chatId),
  ];
}

async function isObjectKeyPermanentlyReferenced(db: D1Database, key: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS found FROM chat_message_states WHERE storage_key = ? OR snapshot_key = ?
       UNION ALL SELECT 1 AS found FROM chats WHERE snapshot_key = ?
       UNION ALL SELECT 1 AS found FROM shares WHERE chat_history_key = ? OR snapshot_key = ?
       UNION ALL SELECT 1 AS found FROM social_shares WHERE thumbnail_image_key = ?
       UNION ALL SELECT 1 AS found FROM deployments WHERE snapshot_key = ?
       LIMIT 1`,
    )
    .bind(key, key, key, key, key, key, key)
    .first<{ found: number }>();
  return row !== null;
}

async function deploymentBuildArtifactLeaseUntil(db: D1Database, key: string): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT updated_at
       FROM deployments
       WHERE build_artifact_key = ?
         AND build_artifact_generation = execution_generation
         AND status IN ('provisioning', 'building', 'deploying')
       ORDER BY updated_at DESC
       LIMIT 1`,
    )
    .bind(key)
    .first<{ updated_at: number }>();
  return row ? row.updated_at + DEPLOYMENT_BUILD_ARTIFACT_LEASE_MS : null;
}

async function chatBackupUploadLeaseUntil(db: D1Database, key: string, now: number): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT MAX(admissions.expires_at) AS expires_at
       FROM chat_backup_object_attributions AS attributions
       JOIN chat_backup_admissions AS admissions ON admissions.id = attributions.admission_id
       WHERE attributions.storage_key = ? AND admissions.status = 'pending'`,
    )
    .bind(key)
    .first<{ expires_at: number }>();
  if (row?.expires_at === null || row?.expires_at === undefined) {
    return null;
  }
  // Expiry only makes an admission eligible for the reconciler's explicit
  // pending -> released transition. Until that transition commits, preserve
  // its objects and residual quota reservation as one atomic unit.
  return row.expires_at > now ? row.expires_at : now + OBJECT_GC_GRACE_PERIOD_MS;
}

async function thumbnailUploadLeaseUntil(db: D1Database, key: string, now: number): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT admissions.expires_at
       FROM thumbnail_objects AS objects
       JOIN thumbnail_upload_admissions AS admissions ON admissions.id = objects.admission_id
       WHERE objects.storage_key = ? AND admissions.status = 'pending'
       LIMIT 1`,
    )
    .bind(key)
    .first<{ expires_at: number }>();
  if (!row) {
    return null;
  }
  // An expired pending admission is still authoritative until the owner or
  // scheduled reconciler commits its explicit release transition.
  return row.expires_at > now ? row.expires_at : now + OBJECT_GC_GRACE_PERIOD_MS;
}

export async function sweepObjectGcCandidates(
  env: Pick<Env, 'APP_STORAGE' | 'DB'>,
  options: { limit?: number; now?: number } = {},
): Promise<number> {
  const limit = Math.max(1, Math.min(options.limit ?? OBJECT_GC_SWEEP_LIMIT, OBJECT_GC_SWEEP_LIMIT));
  const now = options.now ?? Date.now();
  const result = await env.DB.prepare(
    `SELECT storage_key, not_before
     FROM object_gc_candidates
     WHERE not_before <= ?
     ORDER BY not_before, storage_key
     LIMIT ?`,
  )
    .bind(now, limit)
    .all<ObjectGcCandidateRow>();
  let deleted = 0;

  for (const candidate of result.results) {
    const leaseUntil = maximumTimestamp(
      maximumTimestamp(
        await deploymentBuildArtifactLeaseUntil(env.DB, candidate.storage_key),
        await chatBackupUploadLeaseUntil(env.DB, candidate.storage_key, now),
      ),
      await thumbnailUploadLeaseUntil(env.DB, candidate.storage_key, now),
    );
    if (leaseUntil !== null && leaseUntil > now) {
      await rescheduleCandidateIfUnchanged(env.DB, candidate, leaseUntil, now);
      continue;
    }
    await releaseUnreferencedChatBackupAttributions(env.DB, candidate.storage_key);
    if (await isObjectKeyPermanentlyReferenced(env.DB, candidate.storage_key)) {
      await deleteCandidateIfUnchanged(env.DB, candidate, now);
      continue;
    }
    try {
      await deleteObject(env as Env, candidate.storage_key);
      await releaseDeletedCandidateIfUnchanged(env.DB, candidate, now);
      deleted++;
    } catch (error) {
      const retryAt = now + OBJECT_GC_GRACE_PERIOD_MS;
      await env.DB.prepare(
        `UPDATE object_gc_candidates
         SET attempts = attempts + 1, not_before = ?
         WHERE storage_key = ? AND not_before = ? AND not_before <= ?`,
      )
        .bind(retryAt, candidate.storage_key, candidate.not_before, now)
        .run();
      logger.warn('Unable to delete deferred R2 object', { key: candidate.storage_key, error });
    }
  }
  return deleted;
}

function maximumTimestamp(left: number | null, right: number | null): number | null {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  return Math.max(left, right);
}

async function rescheduleCandidateIfUnchanged(
  db: D1Database,
  candidate: ObjectGcCandidateRow,
  notBefore: number,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE object_gc_candidates
       SET not_before = ?
       WHERE storage_key = ? AND not_before = ? AND not_before <= ?`,
    )
    .bind(notBefore, candidate.storage_key, candidate.not_before, now)
    .run();
}

export async function sweepObjectGcCandidatesBestEffort(env: Pick<Env, 'APP_STORAGE' | 'DB'>): Promise<void> {
  try {
    await sweepObjectGcCandidates(env);
  } catch (error) {
    logger.warn('Unable to sweep deferred R2 objects', { error });
  }
}

async function deleteCandidateIfUnchanged(db: D1Database, candidate: ObjectGcCandidateRow, now: number): Promise<void> {
  await prepareDeleteCandidateIfUnchangedStatement(db, candidate, now).run();
}

async function releaseDeletedCandidateIfUnchanged(
  db: D1Database,
  candidate: ObjectGcCandidateRow,
  now: number,
): Promise<void> {
  await db.batch([
    prepareReleaseChatBackupAttributionsStatement(db, {
      storageKey: candidate.storage_key,
      candidateNotBefore: candidate.not_before,
      now,
    }),
    prepareReleaseChatBackupObjectStatement(db, {
      storageKey: candidate.storage_key,
      candidateNotBefore: candidate.not_before,
      now,
    }),
    prepareReleaseThumbnailObjectStatement(db, {
      storageKey: candidate.storage_key,
      candidateNotBefore: candidate.not_before,
      now,
    }),
    prepareDeleteCandidateIfUnchangedStatement(db, candidate, now),
  ]);
}

function prepareDeleteCandidateIfUnchangedStatement(
  db: D1Database,
  candidate: ObjectGcCandidateRow,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM object_gc_candidates
       WHERE storage_key = ? AND not_before = ? AND not_before <= ?`,
    )
    .bind(candidate.storage_key, candidate.not_before, now);
}

function uniqueKeys(keys: Array<string | null>): string[] {
  return Array.from(new Set(keys.filter((key): key is string => key !== null)));
}
