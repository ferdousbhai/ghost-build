import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { MESSAGE_HISTORY_LZ4_LIMITS, PROJECT_SNAPSHOT_LZ4_LIMITS } from '~/lib/compression-limits';
import { objectHead } from './object-storage.server';

const DEFAULT_CHAT_BACKUP_STORAGE_LIMIT_BYTES = 1024 * 1024 * 1024;
// Retained-object cardinality is bounded independently from bytes because tiny
// valid backups still consume R2 metadata and globally shared D1 rows. This
// allows 64 fully retained chats at the current 32-state/two-object ceiling.
const DEFAULT_CHAT_BACKUP_STORAGE_LIMIT_OBJECTS = 4_096;
// The browser sync worker has a one-second debounce. A 120/minute exact limit
// preserves a two-times burst margin while remaining finite per tenant.
const DEFAULT_CHAT_BACKUP_REQUESTS_PER_MINUTE = 120;
const DEFAULT_CHAT_BACKUP_REQUESTS_PER_DAY = 10_000;
export const CHAT_BACKUP_MAX_INTAKE_BYTES =
  MESSAGE_HISTORY_LZ4_LIMITS.compressedBytes + PROJECT_SNAPSHOT_LZ4_LIMITS.compressedBytes + 1024 * 1024;
// Two maximum-sized multipart requests may be materialized concurrently per
// tenant. The reservation is independent from exact retained-object quota.
const DEFAULT_CHAT_BACKUP_INFLIGHT_LIMIT_BYTES = CHAT_BACKUP_MAX_INTAKE_BYTES * 2;
const CHAT_BACKUP_RESERVATION_TTL_MS = 15 * 60 * 1000;
export const CHAT_BACKUP_RECONCILIATION_LIMIT = 256;
export const CHAT_BACKUP_HEAD_CONCURRENCY = 4;
const CHAT_BACKUP_OWNER_ADMISSION_PURGE_LIMIT = 16;
const CHAT_BACKUP_STALE_RESERVATION_RELEASE_LIMIT = 2_048;
const CHAT_BACKUP_GLOBAL_ADMISSION_PURGE_LIMIT = 10_000;

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const logger = createScopedLogger('ChatBackupQuota');

type ChatBackupStorageQuotaMode = 'shadow' | 'enforce';
type ChatBackupObjectKind = 'message-history' | 'snapshot';

export type ChatBackupQuotaConfig = {
  CHAT_BACKUP_STORAGE_QUOTA_MODE?: ChatBackupStorageQuotaMode;
  CHAT_BACKUP_STORAGE_LIMIT_BYTES?: string;
  CHAT_BACKUP_STORAGE_LIMIT_OBJECTS?: string;
  CHAT_BACKUP_REQUESTS_PER_MINUTE?: string;
  CHAT_BACKUP_REQUESTS_PER_DAY?: string;
  CHAT_BACKUP_INFLIGHT_LIMIT_BYTES?: string;
};

type ChatBackupQuotaPolicy = {
  storageMode: ChatBackupStorageQuotaMode;
  storageLimitBytes: number;
  storageLimitObjects: number;
  requestsPerMinute: number;
  requestsPerDay: number;
  inflightLimitBytes: number;
};

type ChatBackupAdmission = {
  id: string;
  ownerId: string;
  reservedBytes: number;
  reservedObjects: number;
  policyViolation: boolean;
};

type AdmissionRow = {
  id: string;
  owner_id: string;
  reserved_bytes: number;
  reserved_objects: number;
  status: 'pending' | 'completed' | 'released';
  policy_violation: number;
  reserved_at: number | null;
};

type UsageRow = {
  retained_bytes: number;
  retained_objects: number;
  minute_requests: number;
  day_requests: number;
  in_flight_bytes: number;
};

type EstimatedObjectRow = {
  storage_key: string;
  size_bytes: number;
};

type ReconciliationStateRow = {
  source_index: number;
  cursor_key: string;
  cursor_owner_id: string;
  measurement_cursor_key: string;
  discovery_passes: number;
  backfill_completed_at: number | null;
};

type LegacyObjectRow = {
  storage_key: string;
  owner_id: string;
};

export class ChatBackupQuotaError extends Error {
  constructor(
    readonly kind: 'edge-rate' | 'request-rate' | 'in-flight' | 'storage' | 'not-ready',
    readonly retryAfterSeconds?: number,
  ) {
    super(
      kind === 'storage'
        ? 'Chat backup storage quota exceeded. Remove older projects or backups before retrying.'
        : kind === 'not-ready'
          ? 'Chat backup storage accounting is still being prepared. Retry later.'
          : kind === 'in-flight'
            ? 'Too many chat backup bytes are already being processed. Retry later.'
            : 'Chat backup request quota exceeded. Retry later.',
    );
    this.name = 'ChatBackupQuotaError';
  }
}

export async function enforceChatBackupEdgeRateLimit(
  env: Pick<Env, 'CHAT_BACKUP_RATE_LIMITER'>,
  ownerId: string,
): Promise<void> {
  if (!env.CHAT_BACKUP_RATE_LIMITER) {
    throw new Error('Cloudflare rate-limit binding CHAT_BACKUP_RATE_LIMITER is not configured');
  }
  const { success } = await env.CHAT_BACKUP_RATE_LIMITER.limit({ key: ownerId });
  if (!success) {
    throw new ChatBackupQuotaError('edge-rate', 60);
  }
}

export async function admitChatBackupRequest(
  env: Pick<Env, 'DB'> & ChatBackupQuotaConfig,
  args: { ownerId: string; chatId: string; now?: number },
): Promise<ChatBackupAdmission> {
  const policy = chatBackupQuotaPolicy(env);
  const now = args.now ?? Date.now();
  await releaseExpiredChatBackupAdmissionsForOwner(env.DB, args.ownerId, now);
  const id = crypto.randomUUID();
  const expiresAt = now + CHAT_BACKUP_RESERVATION_TTL_MS;
  const statement = env.DB.prepare(
    `WITH usage AS (
       SELECT
         (SELECT COUNT(*) FROM chat_backup_admissions
          WHERE owner_id = ? AND created_at >= ?) AS minute_requests,
         (SELECT COUNT(*) FROM chat_backup_admissions
          WHERE owner_id = ? AND created_at >= ?) AS day_requests
     ), decision AS (
       SELECT
         CASE WHEN minute_requests < ?
                   AND day_requests < ?
                   AND COALESCE((
                     SELECT SUM(intake_reserved_bytes)
                     FROM chat_backup_admissions
                     WHERE owner_id = ? AND status = 'pending'
                   ), 0) + ? <= ?
              THEN 0 ELSE 1 END AS policy_violation
       FROM usage
     )
     INSERT INTO chat_backup_admissions (
       id, owner_id, chat_id, reserved_bytes, reserved_objects, intake_reserved_bytes, operation,
       status, policy_violation, created_at, expires_at, reserved_at, completed_at
     )
     SELECT ?, ?, ?, 0, 0, ?, 'upload', 'pending', policy_violation, ?, ?, NULL, NULL
     FROM decision
     WHERE policy_violation = 0`,
  ).bind(
    args.ownerId,
    now - MINUTE_MS,
    args.ownerId,
    now - DAY_MS,
    policy.requestsPerMinute,
    policy.requestsPerDay,
    args.ownerId,
    CHAT_BACKUP_MAX_INTAKE_BYTES,
    policy.inflightLimitBytes,
    id,
    args.ownerId,
    args.chatId,
    CHAT_BACKUP_MAX_INTAKE_BYTES,
    now,
    expiresAt,
  );

  try {
    const result = await statement.run();
    if (result.meta.changes === 1) {
      const admission = await readAdmission(env.DB, id);
      if (!admission) {
        throw new Error('Unable to read committed chat backup quota admission');
      }
      await purgeOwnerAdmissionHistoryBestEffort(env.DB, args.ownerId, now);
      return admissionResult(admission);
    }
  } catch (error) {
    const committed = await readAdmission(env.DB, id).catch(() => null);
    if (committed) {
      await purgeOwnerAdmissionHistoryBestEffort(env.DB, args.ownerId, now);
      return admissionResult(committed);
    }
    throw error;
  }

  const usage = await readUsage(env.DB, args.ownerId, now);
  if (usage.in_flight_bytes + CHAT_BACKUP_MAX_INTAKE_BYTES > policy.inflightLimitBytes) {
    throw new ChatBackupQuotaError('in-flight', 60);
  }
  throw new ChatBackupQuotaError('request-rate', usage.minute_requests >= policy.requestsPerMinute ? 60 : 24 * 60 * 60);
}

export async function reserveChatBackupBytes(
  env: Pick<Env, 'DB'> & ChatBackupQuotaConfig,
  admission: ChatBackupAdmission,
  reservedBytes: number,
  reservedObjects: number,
  now = Date.now(),
): Promise<ChatBackupAdmission> {
  assertSafeByteCount(
    reservedBytes,
    'reservedBytes',
    MESSAGE_HISTORY_LZ4_LIMITS.compressedBytes + PROJECT_SNAPSHOT_LZ4_LIMITS.compressedBytes,
  );
  assertSafeObjectCount(reservedObjects, 'reservedObjects');
  const policy = chatBackupQuotaPolicy(env);
  const statement = env.DB.prepare(
    `WITH usage AS (
       SELECT COALESCE((
           SELECT SUM(objects.size_bytes)
           FROM chat_backup_object_attributions AS attributions
           JOIN chat_backup_objects AS objects ON objects.storage_key = attributions.storage_key
           WHERE attributions.owner_id = ?
         ), 0)
         + COALESCE((
           SELECT SUM(MAX(
             admissions.reserved_bytes - COALESCE((
               SELECT SUM(objects.size_bytes)
               FROM chat_backup_object_attributions AS attributions
               JOIN chat_backup_objects AS objects ON objects.storage_key = attributions.storage_key
               WHERE attributions.admission_id = admissions.id
             ), 0),
             0
           ))
           FROM chat_backup_admissions AS admissions
           WHERE admissions.owner_id = ?
             AND admissions.status = 'pending'
         ), 0) AS retained_bytes,
         COALESCE((
           SELECT COUNT(*) FROM chat_backup_object_attributions WHERE owner_id = ?
         ), 0)
         + COALESCE((
           SELECT SUM(MAX(
             admissions.reserved_objects - COALESCE((
               SELECT COUNT(*)
               FROM chat_backup_object_attributions AS attributions
               WHERE attributions.admission_id = admissions.id
             ), 0),
             0
           ))
           FROM chat_backup_admissions AS admissions
           WHERE admissions.owner_id = ?
             AND admissions.status = 'pending'
         ), 0) AS retained_objects
     )
     UPDATE chat_backup_admissions
     SET reserved_bytes = ?, reserved_objects = ?, reserved_at = ?, expires_at = ?,
         policy_violation = MAX(
           policy_violation,
           (SELECT CASE WHEN retained_bytes + ? <= ?
                              AND retained_objects + ? <= ?
                        THEN 0 ELSE 1 END FROM usage)
         )
     WHERE id = ? AND owner_id = ? AND operation = 'upload' AND status = 'pending' AND reserved_at IS NULL
       AND (
         ? = 'shadow'
         OR (
           EXISTS (
             SELECT 1 FROM chat_backup_reconciliation_state
             WHERE id = 1 AND backfill_completed_at IS NOT NULL
           )
           AND (SELECT retained_bytes + ? <= ?
                       AND retained_objects + ? <= ? FROM usage)
         )
       )`,
  ).bind(
    admission.ownerId,
    admission.ownerId,
    admission.ownerId,
    admission.ownerId,
    reservedBytes,
    reservedObjects,
    now,
    now + CHAT_BACKUP_RESERVATION_TTL_MS,
    reservedBytes,
    policy.storageLimitBytes,
    reservedObjects,
    policy.storageLimitObjects,
    admission.id,
    admission.ownerId,
    policy.storageMode,
    reservedBytes,
    policy.storageLimitBytes,
    reservedObjects,
    policy.storageLimitObjects,
  );
  let result: D1Result;
  try {
    result = await statement.run();
  } catch (error) {
    const current = await readAdmission(env.DB, admission.id).catch(() => null);
    if (isExactReservation(current, admission, reservedBytes, reservedObjects)) {
      return admissionResult(current);
    }
    throw error;
  }
  if (result.meta.changes !== 1) {
    const current = await readAdmission(env.DB, admission.id);
    if (isExactReservation(current, admission, reservedBytes, reservedObjects)) {
      return admissionResult(current);
    }
    if (policy.storageMode === 'enforce' && !(await isBackfillComplete(env.DB))) {
      throw new ChatBackupQuotaError('not-ready', 15 * 60);
    }
    const currentUsage = await readUsage(env.DB, admission.ownerId, now);
    if (
      currentUsage.retained_bytes + reservedBytes > policy.storageLimitBytes ||
      currentUsage.retained_objects + reservedObjects > policy.storageLimitObjects
    ) {
      throw new ChatBackupQuotaError('storage');
    }
    throw new Error('Unable to reserve chat backup bytes');
  }
  const current = await readAdmission(env.DB, admission.id);
  if (!current) {
    throw new Error('Unable to read reserved chat backup quota admission');
  }
  if (current.policy_violation === 1 && !admission.policyViolation) {
    logger.warn('Chat backup exceeded the retained-storage quota policy in shadow mode');
  }
  return admissionResult(current);
}

export async function registerChatBackupObject(
  db: D1Database,
  args: {
    admission: ChatBackupAdmission;
    storageKey: string;
    sizeBytes: number;
    kind: ChatBackupObjectKind;
    now?: number;
  },
): Promise<void> {
  const now = args.now ?? Date.now();
  const maximumBytes =
    args.kind === 'message-history'
      ? MESSAGE_HISTORY_LZ4_LIMITS.compressedBytes
      : PROJECT_SNAPSHOT_LZ4_LIMITS.compressedBytes;
  assertSafeByteCount(args.sizeBytes, 'sizeBytes', maximumBytes);
  try {
    const results = await db.batch([
      db
        .prepare(
          `INSERT INTO chat_backup_objects (storage_key, size_bytes, kind, size_source, created_at)
           SELECT ?, ?, ?, 'measured', ?
           FROM chat_backup_admissions AS admissions
           WHERE admissions.id = ? AND admissions.owner_id = ? AND admissions.operation = 'upload'
             AND admissions.status = 'pending'
             AND admissions.reserved_at IS NOT NULL
             AND ? <= admissions.reserved_bytes - COALESCE((
               SELECT SUM(objects.size_bytes)
               FROM chat_backup_object_attributions AS attributions
               JOIN chat_backup_objects AS objects ON objects.storage_key = attributions.storage_key
               WHERE attributions.admission_id = admissions.id
             ), 0)
             AND 1 <= admissions.reserved_objects - COALESCE((
               SELECT COUNT(*) FROM chat_backup_object_attributions AS attributions
               WHERE attributions.admission_id = admissions.id
             ), 0)
           ON CONFLICT(storage_key) DO NOTHING`,
        )
        .bind(
          args.storageKey,
          args.sizeBytes,
          args.kind,
          now,
          args.admission.id,
          args.admission.ownerId,
          args.sizeBytes,
        ),
      db
        .prepare(
          `INSERT INTO chat_backup_object_attributions (owner_id, storage_key, admission_id, created_at)
           SELECT admissions.owner_id, objects.storage_key, admissions.id, ?
           FROM chat_backup_admissions AS admissions
           JOIN chat_backup_objects AS objects
             ON objects.storage_key = ? AND objects.size_bytes = ? AND objects.kind = ?
           WHERE admissions.id = ? AND admissions.owner_id = ? AND admissions.operation = 'upload'
             AND admissions.status = 'pending'
             AND admissions.reserved_at IS NOT NULL
             AND ? <= admissions.reserved_bytes - COALESCE((
               SELECT SUM(existing_objects.size_bytes)
               FROM chat_backup_object_attributions AS existing_attributions
               JOIN chat_backup_objects AS existing_objects
                 ON existing_objects.storage_key = existing_attributions.storage_key
               WHERE existing_attributions.admission_id = admissions.id
             ), 0)
             AND 1 <= admissions.reserved_objects - COALESCE((
               SELECT COUNT(*) FROM chat_backup_object_attributions AS existing_attributions
               WHERE existing_attributions.admission_id = admissions.id
             ), 0)
           ON CONFLICT(owner_id, storage_key) DO NOTHING`,
        )
        .bind(
          now,
          args.storageKey,
          args.sizeBytes,
          args.kind,
          args.admission.id,
          args.admission.ownerId,
          args.sizeBytes,
        ),
    ]);
    if (results[1]?.meta.changes === 1) {
      return;
    }
  } catch (error) {
    if (await isExactRegisteredObject(db, args).catch(() => false)) {
      return;
    }
    throw error;
  }
  if (!(await isExactRegisteredObject(db, args))) {
    throw new Error('Unable to register chat backup object against its quota admission');
  }
}

export async function registerMaterializedChatBackupObject(
  db: D1Database,
  args: {
    storageKey: string;
    sizeBytes: number;
    kind: ChatBackupObjectKind;
    now?: number;
  },
): Promise<void> {
  const now = args.now ?? Date.now();
  const maximumBytes =
    args.kind === 'message-history'
      ? MESSAGE_HISTORY_LZ4_LIMITS.compressedBytes
      : PROJECT_SNAPSHOT_LZ4_LIMITS.compressedBytes;
  assertSafeByteCount(args.sizeBytes, 'sizeBytes', maximumBytes);
  await db
    .prepare(
      `INSERT INTO chat_backup_objects (storage_key, size_bytes, kind, size_source, created_at)
       VALUES (?, ?, ?, 'measured', ?)
       ON CONFLICT(storage_key) DO NOTHING`,
    )
    .bind(args.storageKey, args.sizeBytes, args.kind, now)
    .run();
  const exact = await db
    .prepare(
      `SELECT 1 AS found FROM chat_backup_objects
       WHERE storage_key = ? AND size_bytes = ? AND kind = ? AND size_source = 'measured'`,
    )
    .bind(args.storageKey, args.sizeBytes, args.kind)
    .first<{ found: number }>();
  if (!exact) {
    throw new Error('Unable to register a materialized chat backup object.');
  }
}

export async function completeChatBackupAdmission(
  db: D1Database,
  admission: ChatBackupAdmission,
  now = Date.now(),
): Promise<void> {
  let result: D1Result;
  try {
    result = await db
      .prepare(
        `UPDATE chat_backup_admissions
       SET status = 'completed', completed_at = ?
       WHERE id = ? AND owner_id = ? AND operation = 'upload' AND status = 'pending' AND reserved_at IS NOT NULL
         AND reserved_bytes = COALESCE((
           SELECT SUM(objects.size_bytes)
           FROM chat_backup_object_attributions AS attributions
           JOIN chat_backup_objects AS objects ON objects.storage_key = attributions.storage_key
           WHERE attributions.admission_id = ?
         ), 0)
         AND reserved_objects = (
           SELECT COUNT(*) FROM chat_backup_object_attributions WHERE admission_id = ?
         )`,
      )
      .bind(now, admission.id, admission.ownerId, admission.id, admission.id)
      .run();
  } catch (error) {
    const current = await readAdmission(db, admission.id).catch(() => null);
    if (current?.owner_id === admission.ownerId && current.status === 'completed') {
      return;
    }
    throw error;
  }
  if (result.meta.changes === 1) {
    return;
  }
  const current = await readAdmission(db, admission.id);
  if (current?.owner_id !== admission.ownerId || current.status !== 'completed') {
    throw new Error('Unable to complete chat backup quota admission');
  }
}

export async function releaseChatBackupAdmissionBestEffort(
  db: D1Database,
  admission: ChatBackupAdmission,
): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE chat_backup_admissions
         SET status = 'released', completed_at = ?
         WHERE id = ? AND owner_id = ? AND operation = 'upload' AND status = 'pending'`,
      )
      .bind(Date.now(), admission.id, admission.ownerId)
      .run();
  } catch (error) {
    logger.warn('Unable to release unused chat backup quota reservation', { admissionId: admission.id, error });
  }
}

type ChatBackupCloneQuotaExtension = {
  admissionId: string;
  prefixStatements: D1PreparedStatement[];
  suffixStatements: D1PreparedStatement[];
  validateResults: (prefixResults: D1Result[], suffixResults: D1Result[]) => boolean;
  verifyReceipt: () => Promise<boolean>;
};

export function createChatBackupCloneQuotaExtension(
  env: Pick<Env, 'DB'> & ChatBackupQuotaConfig,
  args: { ownerId: string; chatId: string; storageKeys: Array<string | null>; now?: number },
): ChatBackupCloneQuotaExtension {
  const policy = chatBackupQuotaPolicy(env);
  const now = args.now ?? Date.now();
  const admissionId = crypto.randomUUID();
  const storageKeys = Array.from(new Set(args.storageKeys.filter((key): key is string => key !== null)));
  if (storageKeys.length < 1 || storageKeys.length > 2) {
    throw new Error('A cloned chat must retain one or two backup objects');
  }
  const releaseExpiredStatement = env.DB.prepare(
    `UPDATE chat_backup_admissions
     SET status = 'released', completed_at = ?
     WHERE owner_id = ? AND status = 'pending' AND expires_at <= ?`,
  ).bind(now, args.ownerId, now);
  const requestedValues = storageKeys.map(() => '(?)').join(', ');
  const admissionStatement = env.DB.prepare(
    `WITH requested(storage_key) AS (VALUES ${requestedValues}),
     known AS (
       SELECT objects.storage_key, objects.size_bytes
       FROM requested JOIN chat_backup_objects AS objects USING (storage_key)
     ), missing AS (
       SELECT known.storage_key, known.size_bytes
       FROM known
       LEFT JOIN chat_backup_object_attributions AS attributions
         ON attributions.owner_id = ? AND attributions.storage_key = known.storage_key
       WHERE attributions.storage_key IS NULL
     ), reservation AS (
       SELECT COALESCE(SUM(size_bytes), 0) AS reserved_bytes, COUNT(*) AS reserved_objects FROM missing
     ), usage AS (
       SELECT COALESCE((
           SELECT SUM(objects.size_bytes)
           FROM chat_backup_object_attributions AS attributions
           JOIN chat_backup_objects AS objects ON objects.storage_key = attributions.storage_key
           WHERE attributions.owner_id = ?
         ), 0) + COALESCE((
           SELECT SUM(MAX(admissions.reserved_bytes - COALESCE((
             SELECT SUM(objects.size_bytes)
             FROM chat_backup_object_attributions AS attributions
             JOIN chat_backup_objects AS objects ON objects.storage_key = attributions.storage_key
             WHERE attributions.admission_id = admissions.id
           ), 0), 0))
           FROM chat_backup_admissions AS admissions
           WHERE admissions.owner_id = ? AND admissions.status = 'pending'
         ), 0) AS retained_bytes,
         COALESCE((SELECT COUNT(*) FROM chat_backup_object_attributions WHERE owner_id = ?), 0)
         + COALESCE((
           SELECT SUM(MAX(admissions.reserved_objects - COALESCE((
             SELECT COUNT(*) FROM chat_backup_object_attributions AS attributions
             WHERE attributions.admission_id = admissions.id
           ), 0), 0))
           FROM chat_backup_admissions AS admissions
           WHERE admissions.owner_id = ? AND admissions.status = 'pending'
         ), 0) AS retained_objects
     ), request_usage AS (
       SELECT
         (SELECT COUNT(*) FROM chat_backup_admissions
          WHERE owner_id = ? AND created_at >= ?) AS minute_requests,
         (SELECT COUNT(*) FROM chat_backup_admissions
          WHERE owner_id = ? AND created_at >= ?) AS day_requests
     )
     INSERT INTO chat_backup_admissions (
       id, owner_id, chat_id, reserved_bytes, reserved_objects, operation,
       status, policy_violation, created_at, expires_at, reserved_at, completed_at
     )
     SELECT ?, ?, ?, reservation.reserved_bytes, reservation.reserved_objects, 'clone', 'pending',
       CASE WHEN usage.retained_bytes + reservation.reserved_bytes <= ?
                  AND usage.retained_objects + reservation.reserved_objects <= ?
            THEN 0 ELSE 1 END,
       ?, ?, ?, NULL
     FROM reservation CROSS JOIN usage CROSS JOIN request_usage
     WHERE request_usage.minute_requests < ? AND request_usage.day_requests < ?
       AND (
         ? = 'shadow'
         OR (
           EXISTS (
             SELECT 1 FROM chat_backup_reconciliation_state WHERE id = 1 AND backfill_completed_at IS NOT NULL
           )
           AND (SELECT COUNT(*) FROM known) = (SELECT COUNT(*) FROM requested)
           AND usage.retained_bytes + reservation.reserved_bytes <= ?
           AND usage.retained_objects + reservation.reserved_objects <= ?
         )
       )`,
  ).bind(
    ...storageKeys,
    args.ownerId,
    args.ownerId,
    args.ownerId,
    args.ownerId,
    args.ownerId,
    args.ownerId,
    now - MINUTE_MS,
    args.ownerId,
    now - DAY_MS,
    admissionId,
    args.ownerId,
    args.chatId,
    policy.storageLimitBytes,
    policy.storageLimitObjects,
    now,
    now + CHAT_BACKUP_RESERVATION_TTL_MS,
    now,
    policy.requestsPerMinute,
    policy.requestsPerDay,
    policy.storageMode,
    policy.storageLimitBytes,
    policy.storageLimitObjects,
  );
  const attributionStatements = storageKeys.map((storageKey) =>
    env.DB.prepare(
      `INSERT INTO chat_backup_object_attributions (owner_id, storage_key, admission_id, created_at)
       SELECT admissions.owner_id, objects.storage_key, admissions.id, ?
       FROM chat_backup_admissions AS admissions
       JOIN chat_backup_objects AS objects ON objects.storage_key = ?
       WHERE admissions.id = ? AND admissions.owner_id = ? AND admissions.operation = 'clone'
         AND admissions.status = 'pending'
       ON CONFLICT(owner_id, storage_key) DO NOTHING`,
    ).bind(now, storageKey, admissionId, args.ownerId),
  );
  const completionStatement = env.DB.prepare(
    `UPDATE chat_backup_admissions
     SET status = 'completed', completed_at = ?
     WHERE id = ? AND owner_id = ? AND operation = 'clone' AND status = 'pending'
       AND reserved_bytes = COALESCE((
         SELECT SUM(objects.size_bytes)
         FROM chat_backup_object_attributions AS attributions
         JOIN chat_backup_objects AS objects ON objects.storage_key = attributions.storage_key
         WHERE attributions.admission_id = ?
       ), 0)
       AND reserved_objects = (
         SELECT COUNT(*) FROM chat_backup_object_attributions WHERE admission_id = ?
       )
       AND EXISTS (
         SELECT 1 FROM chats
         WHERE chats.id = chat_backup_admissions.chat_id
           AND chats.creator_id = chat_backup_admissions.owner_id AND chats.is_deleted = 0
       )`,
  ).bind(now, admissionId, args.ownerId, admissionId, admissionId);
  return {
    admissionId,
    prefixStatements: [releaseExpiredStatement, admissionStatement, ...attributionStatements],
    suffixStatements: [completionStatement],
    validateResults: (prefixResults, suffixResults) =>
      prefixResults[1]?.meta.changes === 1 && suffixResults[0]?.meta.changes === 1,
    verifyReceipt: async () => {
      const receipt = await readAdmission(env.DB, admissionId);
      return receipt?.owner_id === args.ownerId && receipt.status === 'completed';
    },
  };
}

export async function releaseChatBackupCloneAdmissionBestEffort(
  db: D1Database,
  args: { admissionId: string; ownerId: string },
): Promise<void> {
  try {
    const now = Date.now();
    await db.batch([
      db
        .prepare(
          `UPDATE chat_backup_admissions
           SET status = 'released', completed_at = ?
           WHERE id = ? AND owner_id = ? AND operation = 'clone' AND status = 'pending'`,
        )
        .bind(now, args.admissionId, args.ownerId),
      db
        .prepare(
          `DELETE FROM chat_backup_object_attributions AS attributions
           WHERE attributions.admission_id = ? AND attributions.owner_id = ?
             AND EXISTS (
               SELECT 1 FROM chat_backup_admissions
               WHERE id = ? AND owner_id = ? AND operation = 'clone' AND status = 'released'
             )
             AND NOT EXISTS (
               SELECT 1 FROM chats
               WHERE chats.creator_id = attributions.owner_id AND chats.is_deleted = 0
                 AND chats.snapshot_key = attributions.storage_key
               UNION ALL
               SELECT 1 FROM chat_message_states AS states
               JOIN chats ON chats.id = states.chat_id
               WHERE chats.creator_id = attributions.owner_id AND chats.is_deleted = 0
                 AND (states.storage_key = attributions.storage_key OR states.snapshot_key = attributions.storage_key)
               LIMIT 1
             )`,
        )
        .bind(args.admissionId, args.ownerId, args.admissionId, args.ownerId),
    ]);
  } catch (error) {
    logger.warn('Unable to release unused cloned-backup quota attribution', {
      admissionId: args.admissionId,
      error,
    });
  }
}

export async function throwIfChatBackupCloneQuotaDenied(
  env: Pick<Env, 'DB'> & ChatBackupQuotaConfig,
  args: { admissionId: string; ownerId: string; storageKeys: Array<string | null>; now?: number },
): Promise<void> {
  if (await readAdmission(env.DB, args.admissionId)) {
    return;
  }
  const policy = chatBackupQuotaPolicy(env);
  const now = args.now ?? Date.now();
  const usage = await readUsage(env.DB, args.ownerId, now);
  if (usage.minute_requests >= policy.requestsPerMinute || usage.day_requests >= policy.requestsPerDay) {
    throw new ChatBackupQuotaError(
      'request-rate',
      usage.minute_requests >= policy.requestsPerMinute ? 60 : 24 * 60 * 60,
    );
  }
  if (policy.storageMode === 'shadow') {
    return;
  }
  if (!(await isBackfillComplete(env.DB))) {
    throw new ChatBackupQuotaError('not-ready', 15 * 60);
  }
  const storageKeys = Array.from(new Set(args.storageKeys.filter((key): key is string => key !== null)));
  const values = storageKeys.map(() => '(?)').join(', ');
  const reservation = await env.DB.prepare(
    `WITH requested(storage_key) AS (VALUES ${values})
     SELECT COUNT(objects.storage_key) AS known_objects,
       COALESCE(SUM(CASE WHEN attributions.storage_key IS NULL THEN objects.size_bytes ELSE 0 END), 0) AS reserved_bytes,
       SUM(CASE WHEN attributions.storage_key IS NULL AND objects.storage_key IS NOT NULL THEN 1 ELSE 0 END)
         AS reserved_objects
     FROM requested
     LEFT JOIN chat_backup_objects AS objects USING (storage_key)
     LEFT JOIN chat_backup_object_attributions AS attributions
       ON attributions.owner_id = ? AND attributions.storage_key = requested.storage_key`,
  )
    .bind(...storageKeys, args.ownerId)
    .first<{ known_objects: number; reserved_bytes: number; reserved_objects: number }>();
  if (!reservation || reservation.known_objects !== storageKeys.length) {
    throw new ChatBackupQuotaError('not-ready', 15 * 60);
  }
  if (
    usage.retained_bytes + reservation.reserved_bytes > policy.storageLimitBytes ||
    usage.retained_objects + reservation.reserved_objects > policy.storageLimitObjects
  ) {
    throw new ChatBackupQuotaError('storage');
  }
}

export function prepareReleaseChatBackupObjectStatement(
  db: D1Database,
  args: { storageKey: string; candidateNotBefore: number; now: number },
): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM chat_backup_objects
       WHERE storage_key = ?
         AND EXISTS (
           SELECT 1 FROM object_gc_candidates
           WHERE storage_key = ? AND not_before = ? AND not_before <= ?
         )`,
    )
    .bind(args.storageKey, args.storageKey, args.candidateNotBefore, args.now);
}

export function prepareReleaseChatBackupAttributionsStatement(
  db: D1Database,
  args: { storageKey: string; candidateNotBefore: number; now: number },
): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM chat_backup_object_attributions
       WHERE storage_key = ?
         AND EXISTS (
           SELECT 1 FROM object_gc_candidates
           WHERE storage_key = ? AND not_before = ? AND not_before <= ?
         )`,
    )
    .bind(args.storageKey, args.storageKey, args.candidateNotBefore, args.now);
}

export async function releaseUnreferencedChatBackupAttributions(db: D1Database, storageKey: string): Promise<number> {
  const result = await db
    .prepare(
      `DELETE FROM chat_backup_object_attributions AS attributions
       WHERE attributions.storage_key = ?
         AND NOT EXISTS (
           SELECT 1 FROM chats
           WHERE chats.creator_id = attributions.owner_id AND chats.is_deleted = 0
             AND chats.snapshot_key = attributions.storage_key
           UNION ALL
           SELECT 1 FROM chat_message_states AS states
           JOIN chats ON chats.id = states.chat_id
           WHERE chats.creator_id = attributions.owner_id AND chats.is_deleted = 0
             AND (states.storage_key = attributions.storage_key OR states.snapshot_key = attributions.storage_key)
           UNION ALL
           SELECT 1 FROM shares
           JOIN chats ON chats.id = shares.chat_id
           WHERE chats.creator_id = attributions.owner_id AND chats.is_deleted = 0
             AND (shares.chat_history_key = attributions.storage_key OR shares.snapshot_key = attributions.storage_key)
           LIMIT 1
         )`,
    )
    .bind(storageKey)
    .run();
  return result.meta.changes;
}

export async function reconcileChatBackupQuota(
  env: Pick<Env, 'APP_STORAGE' | 'DB'>,
  options: { limit?: number; now?: number } = {},
): Promise<{
  releasedReservations: number;
  purgedAdmissions: number;
  measuredObjects: number;
  discoveryPasses: number;
  backfillComplete: boolean;
}> {
  const now = options.now ?? Date.now();
  const limit = Math.max(
    1,
    Math.min(options.limit ?? CHAT_BACKUP_RECONCILIATION_LIMIT, CHAT_BACKUP_RECONCILIATION_LIMIT),
  );
  const released = await env.DB.prepare(
    `UPDATE chat_backup_admissions
     SET status = 'released', completed_at = ?
     WHERE id IN (
       SELECT id FROM chat_backup_admissions
       WHERE status = 'pending' AND expires_at <= ?
       ORDER BY expires_at, id
       LIMIT ?
     )`,
  )
    .bind(now, now, CHAT_BACKUP_STALE_RESERVATION_RELEASE_LIMIT)
    .run();

  await env.DB.prepare(
    `DELETE FROM chat_backup_object_attributions
     WHERE (owner_id, storage_key) IN (
       SELECT attributions.owner_id, attributions.storage_key
       FROM chat_backup_object_attributions AS attributions
       JOIN chat_backup_admissions AS admissions ON admissions.id = attributions.admission_id
       WHERE admissions.operation = 'clone' AND admissions.status = 'released'
         AND NOT EXISTS (
           SELECT 1 FROM chats
           WHERE chats.creator_id = attributions.owner_id AND chats.is_deleted = 0
             AND chats.snapshot_key = attributions.storage_key
           UNION ALL
           SELECT 1 FROM chat_message_states AS states
           JOIN chats ON chats.id = states.chat_id
           WHERE chats.creator_id = attributions.owner_id AND chats.is_deleted = 0
             AND (states.storage_key = attributions.storage_key OR states.snapshot_key = attributions.storage_key)
           LIMIT 1
         )
       ORDER BY admissions.completed_at, admissions.id, attributions.storage_key
       LIMIT ?
     )`,
  )
    .bind(CHAT_BACKUP_STALE_RESERVATION_RELEASE_LIMIT)
    .run();

  const purged = await env.DB.prepare(
    `DELETE FROM chat_backup_admissions
     WHERE id IN (
       SELECT id FROM chat_backup_admissions AS admissions
       WHERE status IN ('completed', 'released') AND created_at < ?
         AND NOT (
           operation = 'clone' AND status = 'released' AND EXISTS (
             SELECT 1 FROM chat_backup_object_attributions
             WHERE admission_id = admissions.id
           )
         )
       ORDER BY created_at, id
       LIMIT ?
     )`,
  )
    .bind(now - DAY_MS, CHAT_BACKUP_GLOBAL_ADMISSION_PURGE_LIMIT)
    .run();

  await insertMissingLegacyObjects(env.DB, now, limit);
  const reconciliationState = await readReconciliationState(env.DB);
  const rows = await env.DB.prepare(
    `SELECT storage_key, size_bytes
     FROM chat_backup_objects
     WHERE size_source = 'estimated' AND storage_key > ?
     ORDER BY storage_key
     LIMIT ?`,
  )
    .bind(reconciliationState.measurement_cursor_key, limit)
    .all<EstimatedObjectRow>();
  let measuredObjects = 0;
  for (let offset = 0; offset < rows.results.length; offset += CHAT_BACKUP_HEAD_CONCURRENCY) {
    const measured = await Promise.all(
      rows.results.slice(offset, offset + CHAT_BACKUP_HEAD_CONCURRENCY).map((row) => measureLegacyObject(env, row)),
    );
    measuredObjects += measured.reduce((total, changes) => total + changes, 0);
  }
  const nextMeasurementCursor = rows.results.length < limit ? '' : (rows.results.at(-1)?.storage_key ?? '');
  await env.DB.prepare(
    `UPDATE chat_backup_reconciliation_state
     SET measurement_cursor_key = ?, updated_at = ?
     WHERE id = 1 AND measurement_cursor_key = ?`,
  )
    .bind(nextMeasurementCursor, now, reconciliationState.measurement_cursor_key)
    .run();
  await env.DB.prepare(
    `UPDATE chat_backup_reconciliation_state
     SET backfill_completed_at = ?, updated_at = ?
     WHERE id = 1 AND backfill_completed_at IS NULL AND discovery_passes >= 2
       AND NOT EXISTS (
         SELECT 1 FROM chat_backup_objects WHERE size_source = 'estimated'
       )
       AND NOT EXISTS (
         SELECT 1 FROM chat_backup_admissions
         WHERE status = 'pending' AND expires_at <= ?
       )`,
  )
    .bind(now, now, now)
    .run();
  const completedState = await readReconciliationState(env.DB);
  return {
    releasedReservations: released.meta.changes,
    purgedAdmissions: purged.meta.changes,
    measuredObjects,
    discoveryPasses: completedState.discovery_passes,
    backfillComplete: completedState.backfill_completed_at !== null,
  };
}

export async function reconcileChatBackupQuotaBestEffort(env: Pick<Env, 'APP_STORAGE' | 'DB'>): Promise<void> {
  try {
    const result = await reconcileChatBackupQuota(env);
    logger.info('Reconciled chat backup quota accounting', result);
  } catch (error) {
    logger.warn('Unable to reconcile chat backup quota accounting', { error });
  }
}

function chatBackupQuotaPolicy(env: ChatBackupQuotaConfig): ChatBackupQuotaPolicy {
  const storageMode = env.CHAT_BACKUP_STORAGE_QUOTA_MODE ?? 'enforce';
  if (storageMode !== 'shadow' && storageMode !== 'enforce') {
    throw new Error('CHAT_BACKUP_STORAGE_QUOTA_MODE must be either shadow or enforce');
  }
  return {
    storageMode,
    storageLimitBytes: positiveInteger(
      env.CHAT_BACKUP_STORAGE_LIMIT_BYTES,
      DEFAULT_CHAT_BACKUP_STORAGE_LIMIT_BYTES,
      'CHAT_BACKUP_STORAGE_LIMIT_BYTES',
    ),
    storageLimitObjects: positiveInteger(
      env.CHAT_BACKUP_STORAGE_LIMIT_OBJECTS,
      DEFAULT_CHAT_BACKUP_STORAGE_LIMIT_OBJECTS,
      'CHAT_BACKUP_STORAGE_LIMIT_OBJECTS',
    ),
    requestsPerMinute: positiveInteger(
      env.CHAT_BACKUP_REQUESTS_PER_MINUTE,
      DEFAULT_CHAT_BACKUP_REQUESTS_PER_MINUTE,
      'CHAT_BACKUP_REQUESTS_PER_MINUTE',
    ),
    requestsPerDay: positiveInteger(
      env.CHAT_BACKUP_REQUESTS_PER_DAY,
      DEFAULT_CHAT_BACKUP_REQUESTS_PER_DAY,
      'CHAT_BACKUP_REQUESTS_PER_DAY',
    ),
    inflightLimitBytes: positiveInteger(
      env.CHAT_BACKUP_INFLIGHT_LIMIT_BYTES,
      DEFAULT_CHAT_BACKUP_INFLIGHT_LIMIT_BYTES,
      'CHAT_BACKUP_INFLIGHT_LIMIT_BYTES',
    ),
  };
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

async function purgeOwnerAdmissionHistoryBestEffort(db: D1Database, ownerId: string, now: number): Promise<void> {
  try {
    await db
      .prepare(
        `DELETE FROM chat_backup_admissions
         WHERE id IN (
           SELECT id FROM chat_backup_admissions
           WHERE owner_id = ? AND created_at < ?
             AND (status IN ('completed', 'released') OR expires_at <= ?)
             AND NOT (
               operation = 'clone' AND status IN ('pending', 'released') AND EXISTS (
                 SELECT 1 FROM chat_backup_object_attributions AS attributions
                 WHERE attributions.admission_id = chat_backup_admissions.id
               )
             )
           ORDER BY created_at, id
           LIMIT ?
         )`,
      )
      .bind(ownerId, now - DAY_MS, now, CHAT_BACKUP_OWNER_ADMISSION_PURGE_LIMIT)
      .run();
  } catch (error) {
    logger.warn('Unable to purge expired per-user chat backup admission history', { error });
  }
}

async function releaseExpiredChatBackupAdmissionsForOwner(db: D1Database, ownerId: string, now: number): Promise<void> {
  await db
    .prepare(
      `UPDATE chat_backup_admissions
       SET status = 'released', completed_at = ?
       WHERE owner_id = ? AND status = 'pending' AND expires_at <= ?`,
    )
    .bind(now, ownerId, now)
    .run();
}

async function readAdmission(db: D1Database, id: string): Promise<AdmissionRow | null> {
  return db
    .prepare(
      `SELECT id, owner_id, reserved_bytes, reserved_objects, status, policy_violation, reserved_at
       FROM chat_backup_admissions
       WHERE id = ?`,
    )
    .bind(id)
    .first<AdmissionRow>();
}

function admissionResult(row: AdmissionRow): ChatBackupAdmission {
  return {
    id: row.id,
    ownerId: row.owner_id,
    reservedBytes: row.reserved_bytes,
    reservedObjects: row.reserved_objects,
    policyViolation: row.policy_violation === 1,
  };
}

function isExactReservation(
  row: AdmissionRow | null,
  admission: ChatBackupAdmission,
  reservedBytes: number,
  reservedObjects: number,
): row is AdmissionRow {
  return (
    row?.owner_id === admission.ownerId &&
    row.status === 'pending' &&
    row.reserved_at !== null &&
    row.reserved_bytes === reservedBytes &&
    row.reserved_objects === reservedObjects
  );
}

async function readUsage(db: D1Database, ownerId: string, now: number): Promise<UsageRow> {
  const row = await db
    .prepare(
      `SELECT
         COALESCE((
           SELECT SUM(objects.size_bytes)
           FROM chat_backup_object_attributions AS attributions
           JOIN chat_backup_objects AS objects ON objects.storage_key = attributions.storage_key
           WHERE attributions.owner_id = ?
         ), 0)
           + COALESCE((
             SELECT SUM(MAX(
               admissions.reserved_bytes - COALESCE((
                 SELECT SUM(objects.size_bytes)
                 FROM chat_backup_object_attributions AS attributions
                 JOIN chat_backup_objects AS objects ON objects.storage_key = attributions.storage_key
                 WHERE attributions.admission_id = admissions.id
               ), 0),
               0
             ))
             FROM chat_backup_admissions AS admissions
             WHERE admissions.owner_id = ?
               AND admissions.status = 'pending'
           ), 0) AS retained_bytes,
         COALESCE((SELECT COUNT(*) FROM chat_backup_object_attributions WHERE owner_id = ?), 0)
           + COALESCE((
             SELECT SUM(MAX(
               admissions.reserved_objects - COALESCE((
                 SELECT COUNT(*) FROM chat_backup_object_attributions AS attributions
                 WHERE attributions.admission_id = admissions.id
               ), 0),
               0
             ))
             FROM chat_backup_admissions AS admissions
             WHERE admissions.owner_id = ? AND admissions.status = 'pending'
           ), 0) AS retained_objects,
         (SELECT COUNT(*) FROM chat_backup_admissions
          WHERE owner_id = ? AND created_at >= ?) AS minute_requests,
         (SELECT COUNT(*) FROM chat_backup_admissions
          WHERE owner_id = ? AND created_at >= ?) AS day_requests,
         COALESCE((
           SELECT SUM(intake_reserved_bytes) FROM chat_backup_admissions
           WHERE owner_id = ? AND status = 'pending'
         ), 0) AS in_flight_bytes`,
    )
    .bind(ownerId, ownerId, ownerId, ownerId, ownerId, now - MINUTE_MS, ownerId, now - DAY_MS, ownerId)
    .first<UsageRow>();
  if (!row) {
    throw new Error('Unable to read chat backup quota usage');
  }
  return row;
}

async function isExactRegisteredObject(
  db: D1Database,
  args: {
    admission: ChatBackupAdmission;
    storageKey: string;
    sizeBytes: number;
    kind: ChatBackupObjectKind;
  },
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS found
       FROM chat_backup_object_attributions AS attributions
       JOIN chat_backup_objects AS objects ON objects.storage_key = attributions.storage_key
       WHERE attributions.storage_key = ? AND attributions.owner_id = ? AND attributions.admission_id = ?
         AND objects.size_bytes = ? AND objects.kind = ? AND objects.size_source = 'measured'`,
    )
    .bind(args.storageKey, args.admission.ownerId, args.admission.id, args.sizeBytes, args.kind)
    .first<{ found: number }>();
  return row !== null;
}

async function insertMissingLegacyObjects(db: D1Database, now: number, limit: number): Promise<void> {
  let remaining = limit;
  while (remaining > 0) {
    const state = await readReconciliationState(db);
    if (state.backfill_completed_at !== null) {
      return;
    }
    const source = legacyObjectSources[state.source_index];
    if (!source) {
      throw new Error('Invalid chat backup reconciliation source');
    }
    const result = await db
      .prepare(source.query)
      .bind(state.cursor_key, state.cursor_key, state.cursor_owner_id, remaining)
      .all<LegacyObjectRow>();
    const lastKey = result.results.at(-1)?.storage_key ?? '';
    const lastOwnerId = result.results.at(-1)?.owner_id ?? '';
    const sourceComplete = result.results.length < remaining;
    const completedPass = sourceComplete && state.source_index === legacyObjectSources.length - 1;
    const statements = result.results.flatMap((row) => [
      db
        .prepare(
          `INSERT OR IGNORE INTO chat_backup_objects (
             storage_key, size_bytes, kind, size_source, created_at
           ) VALUES (?, ?, ?, 'estimated', ?)`,
        )
        .bind(row.storage_key, source.estimatedBytes, source.kind, now),
      db
        .prepare(
          `INSERT OR IGNORE INTO chat_backup_object_attributions (
             owner_id, storage_key, admission_id, created_at
           )
           SELECT ?, storage_key, NULL, ? FROM chat_backup_objects WHERE storage_key = ?`,
        )
        .bind(row.owner_id, now, row.storage_key),
    ]);
    statements.push(
      db
        .prepare(
          `UPDATE chat_backup_reconciliation_state
           SET source_index = ?, cursor_key = ?, cursor_owner_id = ?,
               discovery_passes = discovery_passes + ?,
               last_discovery_completed_at = CASE WHEN ? = 1 THEN ? ELSE last_discovery_completed_at END,
               updated_at = ?
           WHERE id = 1 AND source_index = ? AND cursor_key = ? AND cursor_owner_id = ?`,
        )
        .bind(
          sourceComplete ? (state.source_index + 1) % legacyObjectSources.length : state.source_index,
          sourceComplete ? '' : lastKey,
          sourceComplete ? '' : lastOwnerId,
          completedPass ? 1 : 0,
          completedPass ? 1 : 0,
          now,
          now,
          state.source_index,
          state.cursor_key,
          state.cursor_owner_id,
        ),
    );
    await db.batch(statements);
    remaining -= result.results.length;
    if (!sourceComplete || completedPass) {
      return;
    }
  }
}

async function measureLegacyObject(env: Pick<Env, 'APP_STORAGE' | 'DB'>, row: EstimatedObjectRow): Promise<number> {
  try {
    const object = await objectHead(env, row.storage_key);
    const result = await env.DB.prepare(
      `UPDATE chat_backup_objects
       SET size_bytes = ?, size_source = 'measured'
       WHERE storage_key = ? AND size_source = 'estimated' AND size_bytes = ?`,
    )
      .bind(object?.size ?? 0, row.storage_key, row.size_bytes)
      .run();
    return result.meta.changes;
  } catch (error) {
    logger.warn('Unable to measure a legacy chat backup object', { error });
    return 0;
  }
}

async function readReconciliationState(db: D1Database): Promise<ReconciliationStateRow> {
  const row = await db
    .prepare(
      `SELECT source_index, cursor_key, cursor_owner_id, measurement_cursor_key
              , discovery_passes, backfill_completed_at
       FROM chat_backup_reconciliation_state
       WHERE id = 1`,
    )
    .first<ReconciliationStateRow>();
  if (!row) {
    throw new Error('Chat backup reconciliation state is not initialized');
  }
  return row;
}

async function isBackfillComplete(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS ready
       FROM chat_backup_reconciliation_state
       WHERE id = 1 AND backfill_completed_at IS NOT NULL`,
    )
    .first<{ ready: number }>();
  return row !== null;
}

function assertSafeByteCount(value: number, name: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${name} must be a safe nonnegative integer no greater than ${maximum}`);
  }
}

function assertSafeObjectCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2) {
    throw new Error(`${name} must be a safe nonnegative integer no greater than 2`);
  }
}

const legacyObjectSources: Array<{
  query: string;
  kind: ChatBackupObjectKind;
  estimatedBytes: number;
}> = [
  {
    query: `SELECT shares.chat_history_key AS storage_key, chats.creator_id AS owner_id
            FROM shares
            JOIN chats ON chats.id = shares.chat_id
            WHERE shares.chat_history_key IS NOT NULL
              AND (shares.chat_history_key > ? OR (shares.chat_history_key = ? AND chats.creator_id > ?))
            ORDER BY shares.chat_history_key, chats.creator_id
            LIMIT ?`,
    kind: 'message-history',
    estimatedBytes: MESSAGE_HISTORY_LZ4_LIMITS.compressedBytes,
  },
  {
    query: `SELECT shares.snapshot_key AS storage_key, chats.creator_id AS owner_id
            FROM shares
            JOIN chats ON chats.id = shares.chat_id
            WHERE shares.snapshot_key IS NOT NULL
              AND (shares.snapshot_key > ? OR (shares.snapshot_key = ? AND chats.creator_id > ?))
            ORDER BY shares.snapshot_key, chats.creator_id
            LIMIT ?`,
    kind: 'snapshot',
    estimatedBytes: PROJECT_SNAPSHOT_LZ4_LIMITS.compressedBytes,
  },
  {
    query: `SELECT states.storage_key, chats.creator_id AS owner_id
            FROM chat_message_states AS states
            JOIN chats ON chats.id = states.chat_id
            WHERE states.storage_key IS NOT NULL
              AND (states.storage_key > ? OR (states.storage_key = ? AND chats.creator_id > ?))
            ORDER BY states.storage_key, chats.creator_id
            LIMIT ?`,
    kind: 'message-history',
    estimatedBytes: MESSAGE_HISTORY_LZ4_LIMITS.compressedBytes,
  },
  {
    query: `SELECT states.snapshot_key AS storage_key, chats.creator_id AS owner_id
            FROM chat_message_states AS states
            JOIN chats ON chats.id = states.chat_id
            WHERE states.snapshot_key IS NOT NULL
              AND (states.snapshot_key > ? OR (states.snapshot_key = ? AND chats.creator_id > ?))
            ORDER BY states.snapshot_key, chats.creator_id
            LIMIT ?`,
    kind: 'snapshot',
    estimatedBytes: PROJECT_SNAPSHOT_LZ4_LIMITS.compressedBytes,
  },
  {
    query: `SELECT chats.snapshot_key AS storage_key, chats.creator_id AS owner_id
            FROM chats
            WHERE chats.snapshot_key IS NOT NULL
              AND (chats.snapshot_key > ? OR (chats.snapshot_key = ? AND chats.creator_id > ?))
            ORDER BY chats.snapshot_key, chats.creator_id
            LIMIT ?`,
    kind: 'snapshot',
    estimatedBytes: PROJECT_SNAPSHOT_LZ4_LIMITS.compressedBytes,
  },
];
