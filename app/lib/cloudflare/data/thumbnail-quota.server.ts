import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { MAX_THUMBNAIL_BYTES } from '~/lib/thumbnail-policy';

const THUMBNAIL_STORAGE_LIMIT_BYTES = 256 * 1024 * 1024;
const THUMBNAIL_STORAGE_LIMIT_OBJECTS = 256;
const THUMBNAIL_REQUESTS_PER_MINUTE = 60;
const THUMBNAIL_REQUESTS_PER_DAY = 1_000;
const THUMBNAIL_INFLIGHT_LIMIT_BYTES = MAX_THUMBNAIL_BYTES * 2;
const THUMBNAIL_ADMISSION_TTL_MS = 10 * 60 * 1_000;
const MINUTE_MS = 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const THUMBNAIL_RECONCILIATION_LIMIT = 32;
const THUMBNAIL_HEAD_CONCURRENCY = 4;
const logger = createScopedLogger('ThumbnailQuota');

export type ThumbnailUploadAdmission = {
  id: string;
  ownerId: string;
  chatId: string;
  reservedBytes: number;
  reservedObjects: number;
  expectedStorageKey: string | null;
};

type AdmissionRow = {
  id: string;
  owner_id: string;
  chat_id: string;
  reserved_bytes: number;
  reserved_objects: number;
  expected_storage_key: string | null;
  status: 'pending' | 'completed' | 'released';
  reserved_at: number | null;
};

type CurrentThumbnailRow = {
  storage_key: string | null;
  size_bytes: number | null;
};

type LegacyThumbnailRow = {
  storage_key: string;
  owner_id: string;
  chat_id: string;
};

export class ThumbnailQuotaError extends Error {
  constructor(
    readonly kind: 'request-rate' | 'in-flight' | 'storage' | 'not-ready',
    readonly retryAfterSeconds?: number,
  ) {
    super(
      kind === 'storage'
        ? 'Thumbnail storage quota exceeded. Remove older projects or thumbnails before retrying.'
        : kind === 'not-ready'
          ? 'Thumbnail storage accounting is still being prepared. Retry later.'
          : kind === 'in-flight'
            ? 'Too many thumbnail bytes are already being processed. Retry later.'
            : 'Thumbnail upload quota exceeded. Retry later.',
    );
    this.name = 'ThumbnailQuotaError';
  }
}

export class ThumbnailReservationStaleError extends Error {
  constructor() {
    super('The current thumbnail changed before quota could be reserved');
    this.name = 'ThumbnailReservationStaleError';
  }
}

export async function admitThumbnailUpload(
  env: Pick<Env, 'APP_STORAGE' | 'DB'>,
  args: { ownerId: string; chatId: string; now?: number },
): Promise<ThumbnailUploadAdmission> {
  const now = args.now ?? Date.now();
  await reconcileThumbnailOwnerQuota(env, args.ownerId, now);
  const id = crypto.randomUUID();
  const statement = env.DB.prepare(
    `WITH usage AS (
       SELECT
         (SELECT COUNT(*) FROM thumbnail_upload_admissions
          WHERE owner_id = ? AND created_at >= ?) AS minute_requests,
         (SELECT COUNT(*) FROM thumbnail_upload_admissions
          WHERE owner_id = ? AND created_at >= ?) AS day_requests,
         COALESCE((SELECT SUM(intake_reserved_bytes) FROM thumbnail_upload_admissions
                   WHERE owner_id = ? AND status = 'pending'), 0) AS in_flight_bytes
     )
     INSERT INTO thumbnail_upload_admissions (
       id, owner_id, chat_id, intake_reserved_bytes, reserved_bytes, reserved_objects,
       expected_storage_key, status, created_at, expires_at, reserved_at, completed_at
     )
     SELECT ?, ?, chats.id, ?, 0, 0, NULL, 'pending', ?, ?, NULL, NULL
     FROM chats CROSS JOIN usage
     WHERE chats.id = ? AND chats.creator_id = ? AND chats.is_deleted = 0
       AND usage.minute_requests < ? AND usage.day_requests < ?
       AND usage.in_flight_bytes + ? <= ?
       AND NOT EXISTS (
         SELECT 1 FROM social_shares AS existing_shares
         JOIN chats AS existing_chats ON existing_chats.id = existing_shares.chat_id
         LEFT JOIN thumbnail_objects AS existing_objects
           ON existing_objects.storage_key = existing_shares.thumbnail_image_key
          AND existing_objects.owner_id = existing_chats.creator_id
          AND existing_objects.chat_id = existing_chats.id
          AND existing_objects.status = 'retained'
         WHERE existing_chats.creator_id = ? AND existing_chats.is_deleted = 0
           AND existing_shares.thumbnail_image_key IS NOT NULL
           AND existing_objects.storage_key IS NULL
       )`,
  ).bind(
    args.ownerId,
    now - MINUTE_MS,
    args.ownerId,
    now - DAY_MS,
    args.ownerId,
    id,
    args.ownerId,
    MAX_THUMBNAIL_BYTES,
    now,
    now + THUMBNAIL_ADMISSION_TTL_MS,
    args.chatId,
    args.ownerId,
    THUMBNAIL_REQUESTS_PER_MINUTE,
    THUMBNAIL_REQUESTS_PER_DAY,
    MAX_THUMBNAIL_BYTES,
    THUMBNAIL_INFLIGHT_LIMIT_BYTES,
    args.ownerId,
  );
  let result: D1Result;
  try {
    result = await statement.run();
  } catch (error) {
    const committed = await readAdmission(env.DB, id).catch(() => null);
    if (committed) {
      return admissionResult(committed);
    }
    throw error;
  }
  if (result.meta.changes === 1) {
    const admission = await readAdmission(env.DB, id);
    if (admission) {
      await purgeThumbnailHistoryBestEffort(env.DB, now);
      return admissionResult(admission);
    }
  }
  const committed = await readAdmission(env.DB, id).catch(() => null);
  if (committed) {
    return admissionResult(committed);
  }
  if (await ownerHasUntrackedThumbnail(env.DB, args.ownerId)) {
    throw new ThumbnailQuotaError('not-ready', 60);
  }
  const usage = await readRequestUsage(env.DB, args.ownerId, now);
  if (usage.inFlightBytes + MAX_THUMBNAIL_BYTES > THUMBNAIL_INFLIGHT_LIMIT_BYTES) {
    throw new ThumbnailQuotaError('in-flight', 60);
  }
  throw new ThumbnailQuotaError(
    'request-rate',
    usage.minuteRequests >= THUMBNAIL_REQUESTS_PER_MINUTE ? 60 : 24 * 60 * 60,
  );
}

export async function reserveThumbnailReplacement(
  db: D1Database,
  admission: ThumbnailUploadAdmission,
  args: { sizeBytes: number; expectedStorageKey: string | null; now?: number },
): Promise<ThumbnailUploadAdmission> {
  assertThumbnailSize(args.sizeBytes);
  const now = args.now ?? Date.now();
  const result = await db
    .prepare(
      `WITH current AS (
         SELECT social_shares.thumbnail_image_key AS storage_key, objects.size_bytes
         FROM social_shares
         JOIN chats ON chats.id = social_shares.chat_id
         LEFT JOIN thumbnail_objects AS objects
           ON objects.storage_key = social_shares.thumbnail_image_key
          AND objects.owner_id = chats.creator_id
          AND objects.chat_id = chats.id
          AND objects.status = 'retained'
         WHERE social_shares.chat_id = ? AND chats.creator_id = ? AND chats.is_deleted = 0
       ), usage AS (
         SELECT
           COALESCE((SELECT SUM(size_bytes) FROM thumbnail_objects
                     WHERE owner_id = ?), 0)
             + COALESCE((
                 SELECT SUM(MAX(
                   admissions.reserved_bytes - COALESCE((
                     SELECT SUM(objects.size_bytes)
                     FROM thumbnail_objects AS objects
                     WHERE objects.admission_id = admissions.id
                   ), 0),
                   0
                 ))
                 FROM thumbnail_upload_admissions AS admissions
                 WHERE admissions.owner_id = ? AND admissions.status = 'pending' AND admissions.id <> ?
               ), 0) AS bytes,
           COALESCE((SELECT COUNT(*) FROM thumbnail_objects
                     WHERE owner_id = ?), 0)
             + COALESCE((
                 SELECT SUM(MAX(
                   admissions.reserved_objects - COALESCE((
                     SELECT COUNT(*)
                     FROM thumbnail_objects AS objects
                     WHERE objects.admission_id = admissions.id
                   ), 0),
                   0
                 ))
                 FROM thumbnail_upload_admissions AS admissions
                 WHERE admissions.owner_id = ? AND admissions.status = 'pending' AND admissions.id <> ?
               ), 0) AS objects
       ), reservation AS (
         SELECT ? AS bytes, 1 AS objects
         FROM current
       )
       UPDATE thumbnail_upload_admissions
       SET reserved_bytes = (SELECT bytes FROM reservation),
           reserved_objects = (SELECT objects FROM reservation),
           expected_storage_key = ?, reserved_at = ?, expires_at = ?
       WHERE id = ? AND owner_id = ? AND chat_id = ? AND status = 'pending'
         AND EXISTS (SELECT 1 FROM current WHERE storage_key IS ?)
         AND (SELECT storage_key IS NULL OR size_bytes IS NOT NULL FROM current)
         AND (SELECT usage.bytes + reservation.bytes <= ?
                     AND usage.objects + reservation.objects <= ? FROM usage, reservation)
         AND NOT EXISTS (
           SELECT 1 FROM social_shares AS existing_shares
           JOIN chats AS existing_chats ON existing_chats.id = existing_shares.chat_id
           LEFT JOIN thumbnail_objects AS existing_objects
             ON existing_objects.storage_key = existing_shares.thumbnail_image_key
            AND existing_objects.owner_id = existing_chats.creator_id
            AND existing_objects.chat_id = existing_chats.id
            AND existing_objects.status = 'retained'
           WHERE existing_chats.creator_id = ? AND existing_chats.is_deleted = 0
             AND existing_shares.thumbnail_image_key IS NOT NULL
             AND existing_objects.storage_key IS NULL
         )`,
    )
    .bind(
      admission.chatId,
      admission.ownerId,
      admission.ownerId,
      admission.ownerId,
      admission.id,
      admission.ownerId,
      admission.ownerId,
      admission.id,
      args.sizeBytes,
      args.expectedStorageKey,
      now,
      now + THUMBNAIL_ADMISSION_TTL_MS,
      admission.id,
      admission.ownerId,
      admission.chatId,
      args.expectedStorageKey,
      THUMBNAIL_STORAGE_LIMIT_BYTES,
      THUMBNAIL_STORAGE_LIMIT_OBJECTS,
      admission.ownerId,
    )
    .run();
  if (result.meta.changes === 1) {
    const reserved = await readAdmission(db, admission.id);
    if (!reserved) {
      throw new Error('Unable to read reserved thumbnail admission');
    }
    return admissionResult(reserved);
  }
  if (await ownerHasUntrackedThumbnail(db, admission.ownerId)) {
    throw new ThumbnailQuotaError('not-ready', 60);
  }
  const exact = await readAdmission(db, admission.id);
  if (
    exact?.status === 'pending' &&
    exact.reserved_at !== null &&
    exact.expected_storage_key === args.expectedStorageKey &&
    exact.reserved_bytes >= 0 &&
    exact.reserved_objects >= 0
  ) {
    return admissionResult(exact);
  }
  const current = await readCurrentThumbnail(db, admission);
  if (
    current?.storage_key !== args.expectedStorageKey ||
    (current.storage_key !== null && current.size_bytes === null)
  ) {
    throw new ThumbnailReservationStaleError();
  }
  throw new ThumbnailQuotaError('storage');
}

export async function registerThumbnailUploadObject(
  db: D1Database,
  args: { admission: ThumbnailUploadAdmission; storageKey: string; sizeBytes: number; now?: number },
): Promise<void> {
  assertThumbnailSize(args.sizeBytes);
  const now = args.now ?? Date.now();
  const result = await db
    .prepare(
      `INSERT INTO thumbnail_objects (
         storage_key, owner_id, chat_id, admission_id, size_bytes, status, created_at, updated_at
       )
       SELECT ?, owner_id, chat_id, id, ?, 'pending', ?, ?
       FROM thumbnail_upload_admissions
       WHERE id = ? AND owner_id = ? AND chat_id = ? AND status = 'pending' AND reserved_at IS NOT NULL
       ON CONFLICT(storage_key) DO NOTHING`,
    )
    .bind(args.storageKey, args.sizeBytes, now, now, args.admission.id, args.admission.ownerId, args.admission.chatId)
    .run();
  if (result.meta.changes !== 1 && !(await isExactPendingObject(db, args))) {
    throw new Error('Unable to register thumbnail object against its quota admission');
  }
}

export async function publishThumbnailReplacement(
  db: D1Database,
  args: {
    admission: ThumbnailUploadAdmission;
    storageKey: string;
    sizeBytes: number;
    displacedStorageKey: string | null;
    gcStatements: D1PreparedStatement[];
    now?: number;
  },
): Promise<'published' | 'stale'> {
  const now = args.now ?? Date.now();
  try {
    const results = await db.batch([
      db
        .prepare(
          `UPDATE social_shares
           SET thumbnail_image_key = ?
           WHERE chat_id = ? AND thumbnail_image_key IS ?
             AND EXISTS (
               SELECT 1 FROM thumbnail_upload_admissions
               WHERE id = ? AND owner_id = ? AND chat_id = ? AND status = 'pending'
                 AND reserved_at IS NOT NULL AND expected_storage_key IS ?
             )
             AND EXISTS (
               SELECT 1 FROM thumbnail_objects
               WHERE storage_key = ? AND owner_id = ? AND chat_id = ? AND admission_id = ?
                 AND size_bytes = ? AND status = 'pending'
             )
             AND NOT EXISTS (
               SELECT 1 FROM social_shares AS other_shares
               JOIN chats AS other_chats ON other_chats.id = other_shares.chat_id
               LEFT JOIN thumbnail_objects AS other_objects
                 ON other_objects.storage_key = other_shares.thumbnail_image_key
                AND other_objects.owner_id = other_chats.creator_id
                AND other_objects.chat_id = other_chats.id
                AND other_objects.status = 'retained'
               WHERE other_chats.creator_id = ? AND other_chats.is_deleted = 0
                 AND other_shares.thumbnail_image_key IS NOT NULL
                 AND other_objects.storage_key IS NULL
             )`,
        )
        .bind(
          args.storageKey,
          args.admission.chatId,
          args.displacedStorageKey,
          args.admission.id,
          args.admission.ownerId,
          args.admission.chatId,
          args.displacedStorageKey,
          args.storageKey,
          args.admission.ownerId,
          args.admission.chatId,
          args.admission.id,
          args.sizeBytes,
          args.admission.ownerId,
        ),
      db
        .prepare(
          `UPDATE thumbnail_objects
           SET status = 'retained', updated_at = ?
           WHERE storage_key = ? AND owner_id = ? AND chat_id = ? AND admission_id = ?
             AND size_bytes = ? AND status IN ('pending', 'retained')
             AND EXISTS (
               SELECT 1 FROM social_shares
               WHERE chat_id = ? AND thumbnail_image_key = ?
             )`,
        )
        .bind(
          now,
          args.storageKey,
          args.admission.ownerId,
          args.admission.chatId,
          args.admission.id,
          args.sizeBytes,
          args.admission.chatId,
          args.storageKey,
        ),
      db
        .prepare(
          `UPDATE thumbnail_objects
           SET status = 'released', updated_at = ?
           WHERE storage_key IS ? AND owner_id = ? AND status = 'retained'
             AND NOT EXISTS (
               SELECT 1 FROM social_shares WHERE thumbnail_image_key = thumbnail_objects.storage_key
             )`,
        )
        .bind(now, args.displacedStorageKey, args.admission.ownerId),
      db
        .prepare(
          `UPDATE thumbnail_upload_admissions
           SET status = 'completed', completed_at = ?
           WHERE id = ? AND owner_id = ? AND chat_id = ? AND status = 'pending'
             AND EXISTS (
               SELECT 1 FROM social_shares WHERE chat_id = ? AND thumbnail_image_key = ?
             )
             AND EXISTS (
               SELECT 1 FROM thumbnail_objects
               WHERE storage_key = ? AND owner_id = ? AND admission_id = ?
                 AND size_bytes = ? AND status = 'retained'
             )`,
        )
        .bind(
          now,
          args.admission.id,
          args.admission.ownerId,
          args.admission.chatId,
          args.admission.chatId,
          args.storageKey,
          args.storageKey,
          args.admission.ownerId,
          args.admission.id,
          args.sizeBytes,
        ),
      ...args.gcStatements,
    ]);
    if (results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1 && results[3]?.meta.changes === 1) {
      return 'published';
    }
  } catch (error) {
    if (await isPublishedReceipt(db, args)) {
      return 'published';
    }
    throw error;
  }
  return (await isPublishedReceipt(db, args)) ? 'published' : 'stale';
}

export async function releaseThumbnailAdmissionBestEffort(
  db: D1Database,
  admission: ThumbnailUploadAdmission,
): Promise<void> {
  try {
    const now = Date.now();
    await db.batch([
      db
        .prepare(
          `UPDATE thumbnail_upload_admissions
           SET status = 'released', completed_at = ?
           WHERE id = ? AND owner_id = ? AND status = 'pending'`,
        )
        .bind(now, admission.id, admission.ownerId),
      db
        .prepare(
          `UPDATE thumbnail_objects
           SET status = 'released', updated_at = ?
           WHERE admission_id = ? AND owner_id = ? AND status = 'pending'
             AND NOT EXISTS (
               SELECT 1 FROM social_shares WHERE thumbnail_image_key = thumbnail_objects.storage_key
             )`,
        )
        .bind(now, admission.id, admission.ownerId),
    ]);
  } catch (error) {
    logger.warn('Unable to release thumbnail quota admission', { admissionId: admission.id, error });
  }
}

export function prepareReleaseThumbnailForChatStatement(
  db: D1Database,
  args: { chatId: string; ownerId: string; now?: number },
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE thumbnail_objects
       SET status = 'released', updated_at = ?
       WHERE owner_id = ? AND chat_id = ? AND status = 'retained'
         AND storage_key IN (
           SELECT thumbnail_image_key FROM social_shares WHERE chat_id = ?
         )`,
    )
    .bind(args.now ?? Date.now(), args.ownerId, args.chatId, args.chatId);
}

export function prepareReleaseThumbnailObjectStatement(
  db: D1Database,
  args: { storageKey: string; candidateNotBefore: number; now: number },
): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM thumbnail_objects
       WHERE storage_key = ?
         AND EXISTS (
           SELECT 1 FROM object_gc_candidates
           WHERE storage_key = ? AND not_before = ? AND not_before <= ?
         )`,
    )
    .bind(args.storageKey, args.storageKey, args.candidateNotBefore, args.now);
}

export async function reconcileThumbnailQuota(
  env: Pick<Env, 'APP_STORAGE' | 'DB'>,
  options: { limit?: number; now?: number } = {},
): Promise<{ releasedAdmissions: number; discoveredObjects: number }> {
  const now = options.now ?? Date.now();
  const limit = Math.max(1, Math.min(options.limit ?? THUMBNAIL_RECONCILIATION_LIMIT, THUMBNAIL_RECONCILIATION_LIMIT));
  const released = await env.DB.prepare(
    `UPDATE thumbnail_upload_admissions
     SET status = 'released', completed_at = ?
     WHERE id IN (
       SELECT id FROM thumbnail_upload_admissions
       WHERE status = 'pending' AND expires_at <= ?
       ORDER BY expires_at, id LIMIT ?
     )`,
  )
    .bind(now, now, limit)
    .run();
  await releaseStaleThumbnailObjects(env.DB, now, limit);
  const state = await env.DB.prepare('SELECT cursor_key FROM thumbnail_reconciliation_state WHERE id = 1').first<{
    cursor_key: string;
  }>();
  if (!state) {
    throw new Error('Thumbnail reconciliation state is not initialized');
  }
  const rows = await env.DB.prepare(
    `SELECT social_shares.thumbnail_image_key AS storage_key, chats.creator_id AS owner_id, chats.id AS chat_id
     FROM social_shares
     JOIN chats ON chats.id = social_shares.chat_id
     LEFT JOIN thumbnail_objects
       ON thumbnail_objects.storage_key = social_shares.thumbnail_image_key
      AND thumbnail_objects.owner_id = chats.creator_id
      AND thumbnail_objects.chat_id = chats.id
      AND thumbnail_objects.status = 'retained'
     WHERE social_shares.thumbnail_image_key IS NOT NULL AND chats.is_deleted = 0
       AND thumbnail_objects.storage_key IS NULL AND social_shares.thumbnail_image_key > ?
     ORDER BY social_shares.thumbnail_image_key LIMIT ?`,
  )
    .bind(state.cursor_key, limit)
    .all<LegacyThumbnailRow>();
  const discoveredObjects = await measureLegacyThumbnails(env, rows.results, now);
  const passComplete = rows.results.length < limit;
  await env.DB.prepare(
    `UPDATE thumbnail_reconciliation_state
     SET cursor_key = ?, discovery_passes = discovery_passes + ?,
         last_discovery_completed_at = CASE WHEN ? = 1 THEN ? ELSE last_discovery_completed_at END,
         updated_at = ?
     WHERE id = 1 AND cursor_key = ?`,
  )
    .bind(
      passComplete ? '' : (rows.results.at(-1)?.storage_key ?? ''),
      passComplete ? 1 : 0,
      passComplete ? 1 : 0,
      now,
      now,
      state.cursor_key,
    )
    .run();
  await purgeThumbnailHistoryBestEffort(env.DB, now);
  return { releasedAdmissions: released.meta.changes, discoveredObjects };
}

export async function reconcileThumbnailQuotaBestEffort(env: Pick<Env, 'APP_STORAGE' | 'DB'>): Promise<void> {
  try {
    logger.info('Reconciled thumbnail quota accounting', await reconcileThumbnailQuota(env));
  } catch (error) {
    logger.warn('Unable to reconcile thumbnail quota accounting', { error });
  }
}

async function reconcileThumbnailOwnerQuota(
  env: Pick<Env, 'APP_STORAGE' | 'DB'>,
  ownerId: string,
  now: number,
): Promise<void> {
  await releaseExpiredThumbnailAdmissionsForOwner(env.DB, ownerId, now);
  await releaseStaleThumbnailObjects(env.DB, now, THUMBNAIL_RECONCILIATION_LIMIT, ownerId);
  const rows = await env.DB.prepare(
    `SELECT social_shares.thumbnail_image_key AS storage_key, chats.creator_id AS owner_id, chats.id AS chat_id
     FROM social_shares
     JOIN chats ON chats.id = social_shares.chat_id
     LEFT JOIN thumbnail_objects
       ON thumbnail_objects.storage_key = social_shares.thumbnail_image_key
      AND thumbnail_objects.owner_id = chats.creator_id
      AND thumbnail_objects.chat_id = chats.id
      AND thumbnail_objects.status = 'retained'
     WHERE chats.creator_id = ? AND chats.is_deleted = 0
       AND social_shares.thumbnail_image_key IS NOT NULL AND thumbnail_objects.storage_key IS NULL
     ORDER BY social_shares.thumbnail_image_key LIMIT ?`,
  )
    .bind(ownerId, THUMBNAIL_RECONCILIATION_LIMIT + 1)
    .all<LegacyThumbnailRow>();
  await measureLegacyThumbnails(env, rows.results.slice(0, THUMBNAIL_RECONCILIATION_LIMIT), now);
  if (rows.results.length > THUMBNAIL_RECONCILIATION_LIMIT) {
    throw new ThumbnailQuotaError('not-ready', 60);
  }
}

async function measureLegacyThumbnails(
  env: Pick<Env, 'APP_STORAGE' | 'DB'>,
  rows: LegacyThumbnailRow[],
  now: number,
): Promise<number> {
  let changes = 0;
  for (let offset = 0; offset < rows.length; offset += THUMBNAIL_HEAD_CONCURRENCY) {
    const measured = await Promise.all(
      rows.slice(offset, offset + THUMBNAIL_HEAD_CONCURRENCY).map(async (row) => {
        const object = await env.APP_STORAGE.head(row.storage_key);
        const result = await env.DB.prepare(
          `INSERT INTO thumbnail_objects (
             storage_key, owner_id, chat_id, admission_id, size_bytes, status, created_at, updated_at
           )
           SELECT ?, ?, ?, NULL, ?, 'retained', ?, ?
           WHERE EXISTS (
             SELECT 1 FROM social_shares
             JOIN chats ON chats.id = social_shares.chat_id
             WHERE social_shares.chat_id = ? AND social_shares.thumbnail_image_key = ?
               AND chats.creator_id = ? AND chats.is_deleted = 0
           )
           ON CONFLICT(storage_key) DO UPDATE SET
             owner_id = excluded.owner_id,
             chat_id = excluded.chat_id,
             admission_id = NULL,
             size_bytes = excluded.size_bytes,
             status = 'retained',
             updated_at = excluded.updated_at`,
        )
          .bind(
            row.storage_key,
            row.owner_id,
            row.chat_id,
            object?.size ?? 0,
            now,
            now,
            row.chat_id,
            row.storage_key,
            row.owner_id,
          )
          .run();
        return result.meta.changes;
      }),
    );
    changes += measured.reduce((sum, value) => sum + value, 0);
  }
  return changes;
}

async function releaseStaleThumbnailObjects(
  db: D1Database,
  now: number,
  limit: number,
  ownerId?: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE thumbnail_objects
       SET status = 'released', updated_at = ?
       WHERE storage_key IN (
         SELECT objects.storage_key FROM thumbnail_objects AS objects
         WHERE objects.status IN ('pending', 'retained')
           AND (? IS NULL OR objects.owner_id = ?)
           AND NOT EXISTS (
             SELECT 1 FROM social_shares WHERE thumbnail_image_key = objects.storage_key
           )
           AND NOT EXISTS (
             SELECT 1 FROM thumbnail_upload_admissions AS admissions
             WHERE admissions.id = objects.admission_id AND admissions.status = 'pending'
           )
         ORDER BY objects.updated_at, objects.storage_key LIMIT ?
       )`,
    )
    .bind(now, ownerId ?? null, ownerId ?? null, limit)
    .run();
}

async function purgeThumbnailHistoryBestEffort(db: D1Database, now: number): Promise<void> {
  try {
    await db
      .prepare(
        `DELETE FROM thumbnail_upload_admissions
         WHERE id IN (
           SELECT admissions.id FROM thumbnail_upload_admissions AS admissions
           WHERE admissions.status IN ('completed', 'released') AND admissions.created_at < ?
             AND NOT EXISTS (
               SELECT 1 FROM thumbnail_objects WHERE admission_id = admissions.id
             )
           ORDER BY admissions.created_at, admissions.id LIMIT ?
         )`,
      )
      .bind(now - DAY_MS, THUMBNAIL_RECONCILIATION_LIMIT)
      .run();
  } catch (error) {
    logger.warn('Unable to purge old thumbnail accounting receipts', { error });
  }
}

async function releaseExpiredThumbnailAdmissionsForOwner(db: D1Database, ownerId: string, now: number): Promise<void> {
  await db
    .prepare(
      `UPDATE thumbnail_upload_admissions
       SET status = 'released', completed_at = ?
       WHERE owner_id = ? AND status = 'pending' AND expires_at <= ?`,
    )
    .bind(now, ownerId, now)
    .run();
}

async function readAdmission(db: D1Database, id: string): Promise<AdmissionRow | null> {
  return db
    .prepare(
      `SELECT id, owner_id, chat_id, reserved_bytes, reserved_objects,
              expected_storage_key, status, reserved_at
       FROM thumbnail_upload_admissions WHERE id = ?`,
    )
    .bind(id)
    .first<AdmissionRow>();
}

function admissionResult(row: AdmissionRow): ThumbnailUploadAdmission {
  return {
    id: row.id,
    ownerId: row.owner_id,
    chatId: row.chat_id,
    reservedBytes: row.reserved_bytes,
    reservedObjects: row.reserved_objects,
    expectedStorageKey: row.expected_storage_key,
  };
}

async function readCurrentThumbnail(
  db: D1Database,
  admission: ThumbnailUploadAdmission,
): Promise<CurrentThumbnailRow | null> {
  return db
    .prepare(
      `SELECT social_shares.thumbnail_image_key AS storage_key, objects.size_bytes
       FROM social_shares
       JOIN chats ON chats.id = social_shares.chat_id
       LEFT JOIN thumbnail_objects AS objects
         ON objects.storage_key = social_shares.thumbnail_image_key
        AND objects.owner_id = chats.creator_id AND objects.status = 'retained'
       WHERE social_shares.chat_id = ? AND chats.creator_id = ? AND chats.is_deleted = 0`,
    )
    .bind(admission.chatId, admission.ownerId)
    .first<CurrentThumbnailRow>();
}

async function readRequestUsage(db: D1Database, ownerId: string, now: number) {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM thumbnail_upload_admissions
          WHERE owner_id = ? AND created_at >= ?) AS minute_requests,
         (SELECT COUNT(*) FROM thumbnail_upload_admissions
          WHERE owner_id = ? AND created_at >= ?) AS day_requests,
         COALESCE((SELECT SUM(intake_reserved_bytes) FROM thumbnail_upload_admissions
                   WHERE owner_id = ? AND status = 'pending'), 0) AS in_flight_bytes`,
    )
    .bind(ownerId, now - MINUTE_MS, ownerId, now - DAY_MS, ownerId)
    .first<{ minute_requests: number; day_requests: number; in_flight_bytes: number }>();
  if (!row) {
    throw new Error('Unable to read thumbnail request usage');
  }
  return {
    minuteRequests: row.minute_requests,
    dayRequests: row.day_requests,
    inFlightBytes: row.in_flight_bytes,
  };
}

async function ownerHasUntrackedThumbnail(db: D1Database, ownerId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS found
       FROM social_shares
       JOIN chats ON chats.id = social_shares.chat_id
       LEFT JOIN thumbnail_objects AS objects
         ON objects.storage_key = social_shares.thumbnail_image_key
        AND objects.owner_id = chats.creator_id
        AND objects.chat_id = chats.id
        AND objects.status = 'retained'
       WHERE chats.creator_id = ? AND chats.is_deleted = 0
         AND social_shares.thumbnail_image_key IS NOT NULL
         AND objects.storage_key IS NULL
       LIMIT 1`,
    )
    .bind(ownerId)
    .first<{ found: number }>();
  return row !== null;
}

async function isExactPendingObject(
  db: D1Database,
  args: { admission: ThumbnailUploadAdmission; storageKey: string; sizeBytes: number },
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS found FROM thumbnail_objects
       WHERE storage_key = ? AND owner_id = ? AND chat_id = ? AND admission_id = ?
         AND size_bytes = ? AND status IN ('pending', 'retained')`,
    )
    .bind(args.storageKey, args.admission.ownerId, args.admission.chatId, args.admission.id, args.sizeBytes)
    .first<{ found: number }>();
  return row !== null;
}

async function isPublishedReceipt(
  db: D1Database,
  args: { admission: ThumbnailUploadAdmission; storageKey: string; sizeBytes: number },
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS found
       FROM thumbnail_upload_admissions AS admissions
       JOIN thumbnail_objects AS objects ON objects.admission_id = admissions.id
       JOIN social_shares ON social_shares.chat_id = admissions.chat_id
       WHERE admissions.id = ? AND admissions.owner_id = ? AND admissions.status = 'completed'
         AND objects.storage_key = ? AND objects.size_bytes = ? AND objects.status = 'retained'
         AND social_shares.thumbnail_image_key = objects.storage_key`,
    )
    .bind(args.admission.id, args.admission.ownerId, args.storageKey, args.sizeBytes)
    .first<{ found: number }>();
  return row !== null;
}

function assertThumbnailSize(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_THUMBNAIL_BYTES) {
    throw new Error(`Thumbnail size must be between 1 and ${MAX_THUMBNAIL_BYTES} bytes`);
  }
}
