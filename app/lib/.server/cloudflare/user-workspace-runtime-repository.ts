export type UserWorkspaceRuntimeStatus = 'provisioning' | 'ready' | 'error';

export type UserWorkspaceRuntime = {
  userId: string;
  connectionId: string;
  connectionGeneration: number;
  workerName: string;
  endpoint: string;
  runtimeVersion: string;
  /** The image this runtime was provisioned onto; null for rows predating the column. */
  imageDigest: string | null;
  status: UserWorkspaceRuntimeStatus;
  lastError: string | null;
  provisioningAttemptId: string | null;
  provisioningLeaseExpiresAt: number | null;
  upgradeDeferredSince: number | null;
  createdAt: number;
  updatedAt: number;
};

type UserWorkspaceRuntimeRow = {
  user_id: string;
  connection_id: string;
  connection_generation: number;
  worker_name: string;
  endpoint: string;
  runtime_version: string;
  image_digest: string | null;
  status: UserWorkspaceRuntimeStatus;
  last_error: string | null;
  provisioning_attempt_id: string | null;
  provisioning_lease_expires_at: number | null;
  upgrade_deferred_since: number | null;
  created_at: number;
  updated_at: number;
};

export async function findUserWorkspaceRuntime(db: D1Database, userId: string): Promise<UserWorkspaceRuntime | null> {
  const row = await db
    .prepare(
      `SELECT user_id, connection_id, connection_generation, worker_name,
              endpoint, runtime_version, image_digest, status, last_error,
              provisioning_attempt_id, provisioning_lease_expires_at, upgrade_deferred_since,
              created_at, updated_at
       FROM user_computer_runtimes
       WHERE user_id = ?`,
    )
    .bind(userId)
    .first<UserWorkspaceRuntimeRow>();
  return row ? runtimeFromRow(row) : null;
}

export async function claimUserWorkspaceRuntimeProvisioning(args: {
  db: D1Database;
  userId: string;
  connectionId: string;
  connectionGeneration: number;
  workerName: string;
  endpoint: string;
  runtimeVersion: string;
  attemptId: string;
  leaseExpiresAt: number;
  now?: number;
}): Promise<{ runtime: UserWorkspaceRuntime; claimed: boolean }> {
  const now = args.now ?? Date.now();
  let row: UserWorkspaceRuntimeRow | null;
  try {
    row = await args.db
      .prepare(
        `INSERT INTO user_computer_runtimes (
         user_id, connection_id, connection_generation, worker_name,
         endpoint, runtime_version, image_digest, status, last_error, created_at, updated_at,
         provisioning_attempt_id, provisioning_lease_expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'provisioning', NULL, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         connection_id = excluded.connection_id,
         connection_generation = excluded.connection_generation,
         worker_name = excluded.worker_name,
         endpoint = excluded.endpoint,
         runtime_version = excluded.runtime_version,
         image_digest = NULL,
         status = 'provisioning',
         last_error = NULL,
         provisioning_attempt_id = excluded.provisioning_attempt_id,
         provisioning_lease_expires_at = excluded.provisioning_lease_expires_at,
         upgrade_deferred_since = NULL,
         updated_at = excluded.updated_at
       WHERE user_computer_runtimes.connection_id <> excluded.connection_id
          OR user_computer_runtimes.connection_generation <> excluded.connection_generation
          OR user_computer_runtimes.runtime_version <> excluded.runtime_version
          OR user_computer_runtimes.status = 'error'
          OR (user_computer_runtimes.status = 'provisioning'
              AND COALESCE(user_computer_runtimes.provisioning_lease_expires_at, 0) <= ?)
       RETURNING user_id, connection_id, connection_generation, worker_name,
                 endpoint, runtime_version, image_digest, status, last_error,
                 provisioning_attempt_id, provisioning_lease_expires_at, upgrade_deferred_since,
                 created_at, updated_at`,
      )
      .bind(
        args.userId,
        args.connectionId,
        args.connectionGeneration,
        args.workerName,
        args.endpoint,
        args.runtimeVersion,
        now,
        now,
        args.attemptId,
        args.leaseExpiresAt,
        now,
      )
      .first<UserWorkspaceRuntimeRow>();
  } catch (error) {
    const committed = await findUserWorkspaceRuntime(args.db, args.userId).catch(() => null);
    if (isExactProvisioningClaim(committed, args, now)) {
      return { runtime: committed, claimed: true };
    }
    throw error;
  }
  if (row) {
    return { runtime: runtimeFromRow(row), claimed: true };
  }
  const existing = await findUserWorkspaceRuntime(args.db, args.userId);
  if (
    existing &&
    existing.connectionId === args.connectionId &&
    existing.connectionGeneration === args.connectionGeneration &&
    existing.runtimeVersion === args.runtimeVersion &&
    (existing.status === 'ready' ||
      (existing.status === 'provisioning' &&
        existing.provisioningLeaseExpiresAt !== null &&
        existing.provisioningLeaseExpiresAt > now))
  ) {
    return { runtime: existing, claimed: false };
  }
  throw new Error('The workspace runtime provisioning claim changed unexpectedly.');
}

function isExactProvisioningClaim(
  runtime: UserWorkspaceRuntime | null,
  args: {
    connectionId: string;
    connectionGeneration: number;
    workerName: string;
    endpoint: string;
    runtimeVersion: string;
    attemptId: string;
    leaseExpiresAt: number;
  },
  updatedAt: number,
): runtime is UserWorkspaceRuntime {
  return (
    runtime?.connectionId === args.connectionId &&
    runtime.connectionGeneration === args.connectionGeneration &&
    runtime.workerName === args.workerName &&
    runtime.endpoint === args.endpoint &&
    runtime.runtimeVersion === args.runtimeVersion &&
    runtime.status === 'provisioning' &&
    runtime.lastError === null &&
    runtime.provisioningAttemptId === args.attemptId &&
    runtime.provisioningLeaseExpiresAt === args.leaseExpiresAt &&
    runtime.updatedAt === updatedAt
  );
}

/**
 * Record that this runtime version is being kept in place while the workspace is busy, and answer
 * with the moment the deferral started. `COALESCE` keeps the first observation: the bound measures
 * how long the user has been pinned on an old runtime, not how recently it was checked. The stored
 * version is matched so a runtime that upgraded underneath this request is left alone.
 */
export async function recordUserWorkspaceRuntimeUpgradeDeferral(args: {
  db: D1Database;
  userId: string;
  runtimeVersion: string;
  now?: number;
}): Promise<number> {
  const now = args.now ?? Date.now();
  const row = await args.db
    .prepare(
      `UPDATE user_computer_runtimes
       SET upgrade_deferred_since = COALESCE(upgrade_deferred_since, ?)
       WHERE user_id = ? AND runtime_version = ?
       RETURNING upgrade_deferred_since`,
    )
    .bind(now, args.userId, args.runtimeVersion)
    .first<{ upgrade_deferred_since: number | null }>();
  return row?.upgrade_deferred_since ?? now;
}

export async function markUserWorkspaceRuntimeReady(args: {
  db: D1Database;
  userId: string;
  connectionId: string;
  connectionGeneration: number;
  runtimeVersion: string;
  attemptId: string;
  imageDigest: string;
  now?: number;
}): Promise<UserWorkspaceRuntime> {
  return transitionRuntime(args, 'ready', null, args.imageDigest);
}

export async function markUserWorkspaceRuntimeError(args: {
  db: D1Database;
  userId: string;
  connectionId: string;
  connectionGeneration: number;
  runtimeVersion: string;
  attemptId: string;
  error: string;
  now?: number;
}): Promise<UserWorkspaceRuntime> {
  return transitionRuntime(args, 'error', args.error.slice(0, 2_000));
}

async function transitionRuntime(
  args: {
    db: D1Database;
    userId: string;
    connectionId: string;
    connectionGeneration: number;
    runtimeVersion: string;
    attemptId: string;
    now?: number;
  },
  status: 'ready' | 'error',
  lastError: string | null,
  imageDigest: string | null = null,
): Promise<UserWorkspaceRuntime> {
  const row = await args.db
    .prepare(
      `UPDATE user_computer_runtimes
       SET status = ?, last_error = ?, image_digest = ?, provisioning_attempt_id = NULL,
           provisioning_lease_expires_at = NULL, updated_at = ?
       WHERE user_id = ? AND connection_id = ? AND connection_generation = ? AND runtime_version = ?
         AND status = 'provisioning' AND provisioning_attempt_id = ?
       RETURNING user_id, connection_id, connection_generation, worker_name,
                 endpoint, runtime_version, image_digest, status, last_error,
                 provisioning_attempt_id, provisioning_lease_expires_at, upgrade_deferred_since,
                 created_at, updated_at`,
    )
    .bind(
      status,
      lastError,
      imageDigest,
      args.now ?? Date.now(),
      args.userId,
      args.connectionId,
      args.connectionGeneration,
      args.runtimeVersion,
      args.attemptId,
    )
    .first<UserWorkspaceRuntimeRow>();
  if (!row) {
    throw new Error('The Cloudflare connection changed while its workspace runtime was being provisioned.');
  }
  return runtimeFromRow(row);
}

function runtimeFromRow(row: UserWorkspaceRuntimeRow): UserWorkspaceRuntime {
  return {
    userId: row.user_id,
    connectionId: row.connection_id,
    connectionGeneration: row.connection_generation,
    workerName: row.worker_name,
    endpoint: row.endpoint,
    runtimeVersion: row.runtime_version,
    imageDigest: row.image_digest,
    status: row.status,
    lastError: row.last_error,
    provisioningAttemptId: row.provisioning_attempt_id,
    provisioningLeaseExpiresAt: row.provisioning_lease_expires_at,
    upgradeDeferredSince: row.upgrade_deferred_since,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
