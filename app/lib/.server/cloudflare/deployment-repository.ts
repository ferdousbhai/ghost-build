import type { DeploymentPlan } from './deployment-plan';

const MAX_RETAINED_DEPLOYMENT_SNAPSHOTS_PER_USER = 3;

export type DeploymentStatus =
  | 'planned'
  | 'awaiting_approval'
  | 'approved'
  | 'provisioning'
  | 'building'
  | 'deploying'
  | 'succeeded'
  | 'failed'
  | 'canceled';

export type Deployment = {
  id: string;
  chatId: string;
  userId: string;
  connectionId: string;
  connectionGeneration: number;
  snapshotKey: string | null;
  status: DeploymentStatus;
  plan: DeploymentPlan;
  planDigest: string;
  approvedDigest: string | null;
  approvedAt: number | null;
  productionUrl: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
};

type DeploymentRow = {
  id: string;
  chat_id: string;
  user_id: string;
  connection_id: string;
  connection_generation: number;
  snapshot_key: string | null;
  status: DeploymentStatus;
  plan_json: string;
  plan_digest: string;
  approved_digest: string | null;
  approved_at: number | null;
  production_url: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
};

export async function createDeployment(args: {
  db: D1Database;
  id: string;
  chatId: string;
  userId: string;
  connectionId: string;
  connectionGeneration: number;
  snapshotKey: string;
  plan: DeploymentPlan;
  planDigest: string;
  now?: number;
}): Promise<Deployment> {
  const now = args.now ?? Date.now();
  const result = await args.db
    .prepare(
      `INSERT INTO deployments (
        id, chat_id, user_id, connection_id, connection_generation, snapshot_key, status, plan_json,
        plan_digest, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, 'awaiting_approval', ?, ?, ?, ?
      WHERE (
        SELECT COUNT(*) FROM deployments
        WHERE user_id = ? AND snapshot_key IS NOT NULL
      ) < ?`,
    )
    .bind(
      args.id,
      args.chatId,
      args.userId,
      args.connectionId,
      args.connectionGeneration,
      args.snapshotKey,
      JSON.stringify(args.plan),
      args.planDigest,
      now,
      now,
      args.userId,
      MAX_RETAINED_DEPLOYMENT_SNAPSHOTS_PER_USER,
    )
    .run();
  if (result.meta.changes !== 1) {
    throw new DeploymentSnapshotLimitError();
  }
  return requireDeploymentForUser(args.db, args.id, args.userId);
}

export async function listExpiredDeploymentSnapshots(args: {
  db: D1Database;
  userId: string;
  updatedBefore: number;
  limit?: number;
}): Promise<Array<{ deploymentId: string; snapshotKey: string }>> {
  const result = await args.db
    .prepare(
      `SELECT id, snapshot_key
       FROM deployments
       WHERE user_id = ? AND snapshot_key IS NOT NULL AND updated_at < ?
         AND status IN ('awaiting_approval', 'succeeded', 'failed', 'canceled')
       ORDER BY updated_at ASC
       LIMIT ?`,
    )
    .bind(args.userId, args.updatedBefore, args.limit ?? 20)
    .all<{ id: string; snapshot_key: string }>();
  return result.results.map((row) => ({ deploymentId: row.id, snapshotKey: row.snapshot_key }));
}

export async function claimOldestReplaceableDeploymentSnapshot(args: {
  db: D1Database;
  userId: string;
}): Promise<{ deploymentId: string; snapshotKey: string } | null> {
  const row = await args.db
    .prepare(
      `SELECT id, snapshot_key
       FROM deployments
       WHERE user_id = ? AND snapshot_key IS NOT NULL
         AND status IN ('awaiting_approval', 'succeeded', 'failed', 'canceled')
         AND (
           SELECT COUNT(*) FROM deployments AS retained
           WHERE retained.user_id = ? AND retained.snapshot_key IS NOT NULL
         ) >= ?
       ORDER BY updated_at ASC
       LIMIT 1`,
    )
    .bind(args.userId, args.userId, MAX_RETAINED_DEPLOYMENT_SNAPSHOTS_PER_USER)
    .first<{ id: string; snapshot_key: string }>();
  if (!row) {
    return null;
  }
  return claimDeploymentSnapshotForRelease({
    db: args.db,
    deploymentId: row.id,
    snapshotKey: row.snapshot_key,
  });
}

export async function claimDeploymentSnapshotForRelease(args: {
  db: D1Database;
  deploymentId: string;
  snapshotKey: string;
  updatedBefore?: number;
  now?: number;
}): Promise<{ deploymentId: string; snapshotKey: string } | null> {
  const result = await args.db
    .prepare(
      `UPDATE deployments
       SET status = CASE WHEN status = 'succeeded' THEN 'succeeded' ELSE 'canceled' END,
           error_code = CASE WHEN status = 'succeeded' THEN error_code ELSE 'deployment_snapshot_released' END,
           error_message = CASE
             WHEN status = 'succeeded' THEN error_message
             ELSE 'The deployment source snapshot was released. Prepare a new deployment plan.'
           END,
           updated_at = ?
       WHERE id = ? AND snapshot_key = ?
         AND status IN ('awaiting_approval', 'succeeded', 'failed', 'canceled')
         AND (? IS NULL OR updated_at < ?)`,
    )
    .bind(
      args.now ?? Date.now(),
      args.deploymentId,
      args.snapshotKey,
      args.updatedBefore ?? null,
      args.updatedBefore ?? null,
    )
    .run();
  return result.meta.changes === 1 ? { deploymentId: args.deploymentId, snapshotKey: args.snapshotKey } : null;
}

export async function clearDeploymentSnapshot(args: {
  db: D1Database;
  deploymentId: string;
  snapshotKey: string;
  now?: number;
}): Promise<boolean> {
  const result = await args.db
    .prepare(
      `UPDATE deployments
       SET snapshot_key = NULL,
           updated_at = ?
       WHERE id = ? AND snapshot_key = ?`,
    )
    .bind(args.now ?? Date.now(), args.deploymentId, args.snapshotKey)
    .run();
  return result.meta.changes === 1;
}

export async function requireDeploymentForUser(
  db: D1Database,
  deploymentId: string,
  userId: string,
): Promise<Deployment> {
  const row = await db
    .prepare(
      `SELECT id, chat_id, user_id, connection_id, connection_generation, snapshot_key, status, plan_json, plan_digest, approved_digest,
              approved_at, production_url, error_code, error_message, created_at, updated_at
       FROM deployments
       WHERE id = ? AND user_id = ?`,
    )
    .bind(deploymentId, userId)
    .first<DeploymentRow>();
  if (!row) {
    throw new DeploymentNotFoundError();
  }
  return deploymentFromRow(row);
}

export async function requireDeployment(db: D1Database, deploymentId: string): Promise<Deployment> {
  const row = await db
    .prepare(
      `SELECT id, chat_id, user_id, connection_id, connection_generation, snapshot_key, status, plan_json, plan_digest, approved_digest,
              approved_at, production_url, error_code, error_message, created_at, updated_at
       FROM deployments WHERE id = ?`,
    )
    .bind(deploymentId)
    .first<DeploymentRow>();
  if (!row) {
    throw new DeploymentNotFoundError();
  }
  return deploymentFromRow(row);
}

export async function claimApprovedDeployment(args: {
  db: D1Database;
  deploymentId: string;
  userId: string;
  connectionId: string;
  connectionGeneration: number;
  now?: number;
}): Promise<Deployment> {
  const current = await requireDeploymentForUser(args.db, args.deploymentId, args.userId);
  if (current.connectionId !== args.connectionId || current.connectionGeneration !== args.connectionGeneration) {
    throw new DeploymentConnectionChangedError();
  }
  if (current.status !== 'approved' || !current.approvedDigest || current.approvedDigest !== current.planDigest) {
    throw new DeploymentStateConflictError(current.status);
  }
  const now = args.now ?? Date.now();
  const result = await args.db
    .prepare(
      `UPDATE deployments
       SET status = 'provisioning', updated_at = ?
       WHERE id = ? AND user_id = ? AND connection_id = ? AND status = 'approved'
         AND approved_digest = plan_digest
         AND connection_generation = ?
         AND EXISTS (
           SELECT 1 FROM cloudflare_connections AS connection
           WHERE connection.id = deployments.connection_id
             AND connection.status = 'active'
             AND connection.connection_generation = deployments.connection_generation
         )
         AND NOT EXISTS (
           SELECT 1 FROM deployments AS active
           WHERE active.user_id = ? AND active.id <> ?
             AND active.status IN ('provisioning', 'building', 'deploying')
         )`,
    )
    .bind(
      now,
      args.deploymentId,
      args.userId,
      args.connectionId,
      args.connectionGeneration,
      args.userId,
      args.deploymentId,
    )
    .run();
  if (result.meta.changes !== 1) {
    const active = await args.db
      .prepare(
        `SELECT id FROM deployments
         WHERE user_id = ? AND id <> ? AND status IN ('provisioning', 'building', 'deploying')
         LIMIT 1`,
      )
      .bind(args.userId, args.deploymentId)
      .first<{ id: string }>();
    if (active) {
      throw new DeploymentConcurrencyLimitError();
    }
    const latest = await requireDeploymentForUser(args.db, args.deploymentId, args.userId);
    const connection = await args.db
      .prepare(`SELECT connection_generation, status FROM cloudflare_connections WHERE id = ?`)
      .bind(args.connectionId)
      .first<{ connection_generation: number; status: string }>();
    if (
      latest.connectionGeneration !== args.connectionGeneration ||
      connection?.status !== 'active' ||
      connection.connection_generation !== args.connectionGeneration
    ) {
      throw new DeploymentConnectionChangedError();
    }
    if (latest.status === 'approved') {
      throw new DeploymentConcurrencyLimitError();
    }
    throw new DeploymentStateConflictError(latest.status);
  }
  return requireDeploymentForUser(args.db, args.deploymentId, args.userId);
}

export async function prepareDeploymentRetry(args: {
  db: D1Database;
  deploymentId: string;
  userId: string;
  connectionId: string;
  connectionGeneration: number;
  now?: number;
}): Promise<Deployment> {
  const result = await args.db
    .prepare(
      `UPDATE deployments
       SET status = 'awaiting_approval', approved_digest = NULL, approved_at = NULL,
           error_code = NULL, error_message = NULL, updated_at = ?
       WHERE id = ? AND user_id = ? AND connection_id = ? AND connection_generation = ? AND snapshot_key IS NOT NULL
         AND status IN ('failed', 'canceled')
         AND COALESCE(error_code, '') <> 'deployment_snapshot_released'`,
    )
    .bind(args.now ?? Date.now(), args.deploymentId, args.userId, args.connectionId, args.connectionGeneration)
    .run();
  if (result.meta.changes !== 1) {
    throw new DeploymentStateConflictError(
      (await requireDeploymentForUser(args.db, args.deploymentId, args.userId)).status,
    );
  }
  return requireDeploymentForUser(args.db, args.deploymentId, args.userId);
}

export async function recordDeploymentResource(args: {
  db: D1Database;
  deploymentId: string;
  resourceType: string;
  logicalName: string;
  providerResourceId: string;
  now?: number;
}): Promise<void> {
  await args.db
    .prepare(
      `INSERT INTO deployment_resources (
        id, deployment_id, resource_type, logical_name, provider_resource_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(deployment_id, resource_type, logical_name) DO UPDATE SET
        provider_resource_id = excluded.provider_resource_id`,
    )
    .bind(
      crypto.randomUUID(),
      args.deploymentId,
      args.resourceType,
      args.logicalName,
      args.providerResourceId,
      args.now ?? Date.now(),
    )
    .run();
}

export async function listDeploymentResources(
  db: D1Database,
  deploymentId: string,
): Promise<Array<{ resourceType: string; logicalName: string; providerResourceId: string }>> {
  const result = await db
    .prepare(
      `SELECT resource_type, logical_name, provider_resource_id
       FROM deployment_resources WHERE deployment_id = ? ORDER BY created_at, id`,
    )
    .bind(deploymentId)
    .all<{ resource_type: string; logical_name: string; provider_resource_id: string }>();
  return result.results.map((row) => ({
    resourceType: row.resource_type,
    logicalName: row.logical_name,
    providerResourceId: row.provider_resource_id,
  }));
}

export async function transitionDeployment(args: {
  db: D1Database;
  deploymentId: string;
  expectedStatus: DeploymentStatus;
  nextStatus: DeploymentStatus;
  productionUrl?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  now?: number;
}): Promise<void> {
  const result = await args.db
    .prepare(
      `UPDATE deployments
       SET status = ?, production_url = ?, error_code = ?, error_message = ?, updated_at = ?
       WHERE id = ? AND status = ?`,
    )
    .bind(
      args.nextStatus,
      args.productionUrl ?? null,
      args.errorCode ?? null,
      args.errorMessage ?? null,
      args.now ?? Date.now(),
      args.deploymentId,
      args.expectedStatus,
    )
    .run();
  if (result.meta.changes !== 1) {
    throw new DeploymentStateConflictError(args.expectedStatus);
  }
}

export async function approveDeployment(args: {
  db: D1Database;
  deploymentId: string;
  userId: string;
  connectionId: string;
  connectionGeneration: number;
  approvedDigest: string;
  now?: number;
}): Promise<Deployment> {
  const now = args.now ?? Date.now();
  const result = await args.db
    .prepare(
      `UPDATE deployments
       SET status = 'approved', approved_digest = ?, approved_at = ?, updated_at = ?
       WHERE id = ? AND user_id = ? AND connection_id = ? AND connection_generation = ?
         AND status = 'awaiting_approval'
         AND plan_digest = ?`,
    )
    .bind(
      args.approvedDigest,
      now,
      now,
      args.deploymentId,
      args.userId,
      args.connectionId,
      args.connectionGeneration,
      args.approvedDigest,
    )
    .run();
  if (result.meta.changes !== 1) {
    const current = await requireDeploymentForUser(args.db, args.deploymentId, args.userId);
    if (current.planDigest !== args.approvedDigest) {
      throw new DeploymentApprovalDigestMismatchError();
    }
    if (current.connectionId !== args.connectionId || current.connectionGeneration !== args.connectionGeneration) {
      throw new DeploymentConnectionChangedError();
    }
    throw new DeploymentStateConflictError(current.status);
  }
  return requireDeploymentForUser(args.db, args.deploymentId, args.userId);
}

export class DeploymentNotFoundError extends Error {
  constructor() {
    super('Deployment not found.');
    this.name = 'DeploymentNotFoundError';
  }
}

export class DeploymentApprovalDigestMismatchError extends Error {
  constructor() {
    super('The deployment plan changed and must be reviewed again.');
    this.name = 'DeploymentApprovalDigestMismatchError';
  }
}

export class DeploymentConnectionChangedError extends Error {
  constructor() {
    super('The Cloudflare connection changed and this deployment must be prepared again.');
    this.name = 'DeploymentConnectionChangedError';
  }
}

export class DeploymentStateConflictError extends Error {
  constructor(readonly status: DeploymentStatus) {
    super(`Deployment cannot continue from status ${status}.`);
    this.name = 'DeploymentStateConflictError';
  }
}

export class DeploymentConcurrencyLimitError extends Error {
  constructor() {
    super('Finish the active deployment before starting another one.');
    this.name = 'DeploymentConcurrencyLimitError';
  }
}

export class DeploymentSnapshotLimitError extends Error {
  constructor() {
    super(
      `At most ${MAX_RETAINED_DEPLOYMENT_SNAPSHOTS_PER_USER} deployment plans may retain source snapshots. ` +
        'Finish or retry an existing plan, or wait for an abandoned plan to expire.',
    );
    this.name = 'DeploymentSnapshotLimitError';
  }
}

function deploymentFromRow(row: DeploymentRow): Deployment {
  return {
    id: row.id,
    chatId: row.chat_id,
    userId: row.user_id,
    connectionId: row.connection_id,
    connectionGeneration: row.connection_generation,
    snapshotKey: row.snapshot_key,
    status: row.status,
    plan: JSON.parse(row.plan_json) as DeploymentPlan,
    planDigest: row.plan_digest,
    approvedDigest: row.approved_digest,
    approvedAt: row.approved_at,
    productionUrl: row.production_url,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
