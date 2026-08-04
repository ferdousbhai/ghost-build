export type UserWorkspaceRuntimeStatus = 'provisioning' | 'ready' | 'error';

export type UserWorkspaceRuntime = {
  userId: string;
  connectionId: string;
  connectionGeneration: number;
  workerName: string;
  endpoint: string;
  runtimeVersion: string;
  status: UserWorkspaceRuntimeStatus;
  lastError: string | null;
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
  status: UserWorkspaceRuntimeStatus;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};

export async function findUserWorkspaceRuntime(db: D1Database, userId: string): Promise<UserWorkspaceRuntime | null> {
  const row = await db
    .prepare(
      `SELECT user_id, connection_id, connection_generation, worker_name,
              endpoint, runtime_version, status, last_error, created_at, updated_at
       FROM user_computer_runtimes
       WHERE user_id = ?`,
    )
    .bind(userId)
    .first<UserWorkspaceRuntimeRow>();
  return row ? runtimeFromRow(row) : null;
}

export async function recordUserWorkspaceRuntimeProvisioning(args: {
  db: D1Database;
  userId: string;
  connectionId: string;
  connectionGeneration: number;
  workerName: string;
  endpoint: string;
  runtimeVersion: string;
  now?: number;
}): Promise<UserWorkspaceRuntime> {
  const now = args.now ?? Date.now();
  const row = await args.db
    .prepare(
      `INSERT INTO user_computer_runtimes (
         user_id, connection_id, connection_generation, worker_name,
         endpoint, runtime_version, status, last_error, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'provisioning', NULL, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         connection_id = excluded.connection_id,
         connection_generation = excluded.connection_generation,
         worker_name = excluded.worker_name,
         endpoint = excluded.endpoint,
         runtime_version = excluded.runtime_version,
         status = 'provisioning',
         last_error = NULL,
         updated_at = excluded.updated_at
       RETURNING user_id, connection_id, connection_generation, worker_name,
                 endpoint, runtime_version, status, last_error, created_at, updated_at`,
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
    )
    .first<UserWorkspaceRuntimeRow>();
  if (!row) {
    throw new Error('Unable to record the user-owned workspace runtime.');
  }
  return runtimeFromRow(row);
}

export async function markUserWorkspaceRuntimeReady(args: {
  db: D1Database;
  userId: string;
  connectionId: string;
  connectionGeneration: number;
  runtimeVersion: string;
  now?: number;
}): Promise<UserWorkspaceRuntime> {
  return transitionRuntime(args, 'ready', null);
}

export async function markUserWorkspaceRuntimeError(args: {
  db: D1Database;
  userId: string;
  connectionId: string;
  connectionGeneration: number;
  runtimeVersion: string;
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
    now?: number;
  },
  status: 'ready' | 'error',
  lastError: string | null,
): Promise<UserWorkspaceRuntime> {
  const row = await args.db
    .prepare(
      `UPDATE user_computer_runtimes
       SET status = ?, last_error = ?, updated_at = ?
       WHERE user_id = ? AND connection_id = ? AND connection_generation = ? AND runtime_version = ?
       RETURNING user_id, connection_id, connection_generation, worker_name,
                 endpoint, runtime_version, status, last_error, created_at, updated_at`,
    )
    .bind(
      status,
      lastError,
      args.now ?? Date.now(),
      args.userId,
      args.connectionId,
      args.connectionGeneration,
      args.runtimeVersion,
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
    status: row.status,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
