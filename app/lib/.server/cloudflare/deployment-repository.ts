import type { DeploymentPlan } from './deployment-plan';

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
  snapshotKey: string;
  plan: DeploymentPlan;
  planDigest: string;
  now?: number;
}): Promise<Deployment> {
  const now = args.now ?? Date.now();
  await args.db
    .prepare(
      `INSERT INTO deployments (
        id, chat_id, user_id, connection_id, snapshot_key, status, plan_json,
        plan_digest, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'awaiting_approval', ?, ?, ?, ?)`,
    )
    .bind(
      args.id,
      args.chatId,
      args.userId,
      args.connectionId,
      args.snapshotKey,
      JSON.stringify(args.plan),
      args.planDigest,
      now,
      now,
    )
    .run();
  return requireDeploymentForUser(args.db, args.id, args.userId);
}

export async function requireDeploymentForUser(
  db: D1Database,
  deploymentId: string,
  userId: string,
): Promise<Deployment> {
  const row = await db
    .prepare(
      `SELECT id, chat_id, user_id, connection_id, snapshot_key, status, plan_json, plan_digest, approved_digest,
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
      `SELECT id, chat_id, user_id, connection_id, snapshot_key, status, plan_json, plan_digest, approved_digest,
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
  now?: number;
}): Promise<Deployment> {
  const current = await requireDeploymentForUser(args.db, args.deploymentId, args.userId);
  if (
    current.connectionId !== args.connectionId ||
    current.status !== 'approved' ||
    !current.approvedDigest ||
    current.approvedDigest !== current.planDigest
  ) {
    throw new DeploymentStateConflictError(current.status);
  }
  const now = args.now ?? Date.now();
  const result = await args.db
    .prepare(
      `UPDATE deployments
       SET status = 'provisioning', updated_at = ?
       WHERE id = ? AND user_id = ? AND connection_id = ? AND status = 'approved'
         AND approved_digest = plan_digest`,
    )
    .bind(now, args.deploymentId, args.userId, args.connectionId)
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
  approvedDigest: string;
  now?: number;
}): Promise<Deployment> {
  const now = args.now ?? Date.now();
  const result = await args.db
    .prepare(
      `UPDATE deployments
       SET status = 'approved', approved_digest = ?, approved_at = ?, updated_at = ?
       WHERE id = ? AND user_id = ? AND connection_id = ? AND status = 'awaiting_approval'
         AND plan_digest = ?`,
    )
    .bind(args.approvedDigest, now, now, args.deploymentId, args.userId, args.connectionId, args.approvedDigest)
    .run();
  if (result.meta.changes !== 1) {
    const current = await requireDeploymentForUser(args.db, args.deploymentId, args.userId);
    if (current.planDigest !== args.approvedDigest) {
      throw new DeploymentApprovalDigestMismatchError();
    }
    if (current.connectionId !== args.connectionId) {
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

function deploymentFromRow(row: DeploymentRow): Deployment {
  return {
    id: row.id,
    chatId: row.chat_id,
    userId: row.user_id,
    connectionId: row.connection_id,
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
