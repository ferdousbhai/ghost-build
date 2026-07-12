import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { deleteObject } from './object-storage.server';

export const OBJECT_GC_GRACE_PERIOD_MS = 5 * 60 * 1000;
export const OBJECT_GC_SWEEP_LIMIT = 8;

const logger = createScopedLogger('CloudflareObjectGc');

type ObjectGcCandidateRow = {
  storage_key: string;
  not_before: number;
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

async function isObjectKeyReferenced(db: D1Database, key: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS found FROM chat_message_states WHERE storage_key = ? OR snapshot_key = ?
       UNION ALL SELECT 1 AS found FROM chats WHERE snapshot_key = ?
       UNION ALL SELECT 1 AS found FROM shares WHERE chat_history_key = ? OR snapshot_key = ?
       UNION ALL SELECT 1 AS found FROM social_shares WHERE thumbnail_image_key = ?
       LIMIT 1`,
    )
    .bind(key, key, key, key, key, key)
    .first<{ found: number }>();
  return row !== null;
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
    if (await isObjectKeyReferenced(env.DB, candidate.storage_key)) {
      await deleteCandidateIfUnchanged(env.DB, candidate, now);
      continue;
    }
    try {
      await deleteObject(env as Env, candidate.storage_key);
      await deleteCandidateIfUnchanged(env.DB, candidate, now);
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

export async function sweepObjectGcCandidatesBestEffort(env: Pick<Env, 'APP_STORAGE' | 'DB'>): Promise<void> {
  try {
    await sweepObjectGcCandidates(env);
  } catch (error) {
    logger.warn('Unable to sweep deferred R2 objects', { error });
  }
}

async function deleteCandidateIfUnchanged(db: D1Database, candidate: ObjectGcCandidateRow, now: number): Promise<void> {
  await db
    .prepare(
      `DELETE FROM object_gc_candidates
       WHERE storage_key = ? AND not_before = ? AND not_before <= ?`,
    )
    .bind(candidate.storage_key, candidate.not_before, now)
    .run();
}

function uniqueKeys(keys: Array<string | null>): string[] {
  return Array.from(new Set(keys.filter((key): key is string => key !== null)));
}
