import type { DeploymentPlan } from './deployment-plan';
import {
  DEPLOYMENT_BUILD_ARTIFACT_LEASE_MS,
  OBJECT_GC_GRACE_PERIOD_MS,
  prepareObjectGcCandidateStatements,
} from '~/lib/cloudflare/data/object-gc.server';

const MAX_RETAINED_DEPLOYMENT_SNAPSHOTS_PER_USER = 3;
// Each Workflow step uses a 30-minute project timeout and persists a D1/R2
// boundary before the next phase. Keep a small grace period beyond one step so
// a second execution cannot reconcile valid in-flight work as failed.
const STALE_ACTIVE_DEPLOYMENT_MS = DEPLOYMENT_BUILD_ARTIFACT_LEASE_MS;

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
  executionGeneration: number;
  buildArtifactKey: string | null;
  buildArtifactGeneration: number | null;
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
  execution_generation: number;
  build_artifact_key: string | null;
  build_artifact_generation: number | null;
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
  try {
    const result = await args.db
      .prepare(
        `INSERT INTO deployments (
        id, chat_id, user_id, connection_id, connection_generation, execution_generation, snapshot_key, status, plan_json,
        plan_digest, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, 0, ?, 'awaiting_approval', ?, ?, ?, ?
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
    return await requireDeploymentForUser(args.db, args.id, args.userId);
  } catch (error) {
    try {
      const committed = await findDeploymentSnapshotCommit({
        db: args.db,
        deploymentId: args.id,
        userId: args.userId,
        snapshotKey: args.snapshotKey,
        planDigest: args.planDigest,
      });
      if (committed) {
        return committed;
      }
    } catch {
      // The caller's reference-aware GC receipt remains durable when D1
      // reconciliation is itself unavailable. Never turn ambiguity into an
      // object deletion that could break a committed deployment.
    }
    throw error;
  }
}

async function findDeploymentSnapshotCommit(args: {
  db: D1Database;
  deploymentId: string;
  userId: string;
  snapshotKey: string;
  planDigest: string;
}): Promise<Deployment | null> {
  const row = await args.db
    .prepare(
      `SELECT id, chat_id, user_id, connection_id, connection_generation, execution_generation,
              build_artifact_key, build_artifact_generation, snapshot_key, status,
              plan_json, plan_digest, approved_digest, approved_at, production_url, error_code, error_message,
              created_at, updated_at
       FROM deployments
       WHERE id = ? AND user_id = ? AND snapshot_key = ? AND plan_digest = ?`,
    )
    .bind(args.deploymentId, args.userId, args.snapshotKey, args.planDigest)
    .first<DeploymentRow>();
  return row ? deploymentFromRow(row) : null;
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

async function claimDeploymentSnapshotForRelease(args: {
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

export async function requireDeploymentForUser(
  db: D1Database,
  deploymentId: string,
  userId: string,
): Promise<Deployment> {
  const row = await db
    .prepare(
      `SELECT id, chat_id, user_id, connection_id, connection_generation, execution_generation,
              build_artifact_key, build_artifact_generation, snapshot_key, status, plan_json, plan_digest, approved_digest,
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
      `SELECT id, chat_id, user_id, connection_id, connection_generation, execution_generation,
              build_artifact_key, build_artifact_generation, snapshot_key, status, plan_json, plan_digest, approved_digest,
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

/**
 * Bridges approvals committed by the previously deployed Worker after the
 * execution-generation migration ran but before the new Worker became active.
 * The exact approval identity is compare-and-swapped so generation zero can
 * only become the first immutable execution generation.
 */
export async function adoptLegacyApprovedDeploymentExecutionGeneration(args: {
  db: D1Database;
  deployment: Deployment;
}): Promise<Deployment> {
  if (Number.isSafeInteger(args.deployment.executionGeneration) && args.deployment.executionGeneration > 0) {
    return args.deployment;
  }
  if (!isLegacyApprovedDeployment(args.deployment)) {
    throw new DeploymentStateConflictError(args.deployment.status);
  }

  try {
    const result = await args.db
      .prepare(
        `UPDATE deployments
         SET execution_generation = 1
         WHERE id = ? AND user_id = ? AND connection_id = ? AND connection_generation = ?
           AND execution_generation = 0 AND status = 'approved'
           AND approved_at = ? AND approved_digest = ? AND plan_digest = ? AND snapshot_key = ?
           AND build_artifact_key IS NULL AND build_artifact_generation IS NULL`,
      )
      .bind(
        args.deployment.id,
        args.deployment.userId,
        args.deployment.connectionId,
        args.deployment.connectionGeneration,
        args.deployment.approvedAt,
        args.deployment.approvedDigest,
        args.deployment.planDigest,
        args.deployment.snapshotKey,
      )
      .run();
    if (result.meta.changes === 1) {
      return { ...args.deployment, executionGeneration: 1 };
    }
  } catch (error) {
    const committed = await readMatchingAdoptedLegacyApproval(args).catch(() => null);
    if (committed) {
      return committed;
    }
    throw error;
  }

  const committed = await readMatchingAdoptedLegacyApproval(args);
  if (committed) {
    return committed;
  }
  throw new DeploymentStateConflictError(
    (await requireDeploymentForUser(args.db, args.deployment.id, args.deployment.userId)).status,
  );
}

async function readMatchingAdoptedLegacyApproval(args: {
  db: D1Database;
  deployment: Deployment;
}): Promise<Deployment | null> {
  const latest = await requireDeploymentForUser(args.db, args.deployment.id, args.deployment.userId);
  return latest.executionGeneration === 1 && isSameApprovedDeploymentIdentity(latest, args.deployment) ? latest : null;
}

function isLegacyApprovedDeployment(deployment: Deployment): boolean {
  return (
    deployment.executionGeneration === 0 &&
    deployment.status === 'approved' &&
    deployment.approvedAt !== null &&
    deployment.approvedDigest !== null &&
    deployment.approvedDigest === deployment.planDigest &&
    deployment.snapshotKey !== null &&
    deployment.buildArtifactKey === null &&
    deployment.buildArtifactGeneration === null &&
    deployment.plan.deploymentId === deployment.id
  );
}

function isSameApprovedDeploymentIdentity(current: Deployment, expected: Deployment): boolean {
  return (
    current.id === expected.id &&
    current.userId === expected.userId &&
    current.connectionId === expected.connectionId &&
    current.connectionGeneration === expected.connectionGeneration &&
    current.status === 'approved' &&
    current.approvedAt === expected.approvedAt &&
    current.approvedDigest === expected.approvedDigest &&
    current.planDigest === expected.planDigest &&
    current.snapshotKey === expected.snapshotKey &&
    current.buildArtifactKey === expected.buildArtifactKey &&
    current.buildArtifactGeneration === expected.buildArtifactGeneration &&
    current.plan.deploymentId === expected.plan.deploymentId
  );
}

export async function retainDeploymentBuildArtifactReference(args: {
  db: D1Database;
  deploymentId: string;
  executionGeneration: number;
  objectKey: string;
  now?: number;
}): Promise<void> {
  if (
    !Number.isSafeInteger(args.executionGeneration) ||
    args.executionGeneration < 1 ||
    !args.objectKey ||
    args.objectKey.length > 1_024
  ) {
    throw new DeploymentStateConflictError('building');
  }
  const now = args.now ?? Date.now();
  const gcStatements = prepareObjectGcCandidateStatements(args.db, [args.objectKey], now);
  const retainStatement = args.db
    .prepare(
      `UPDATE deployments
       SET build_artifact_key = ?, build_artifact_generation = ?, updated_at = ?
       WHERE id = ? AND execution_generation = ?
         AND status IN ('provisioning', 'building')
         AND (
           build_artifact_key IS NULL OR
           (build_artifact_key = ? AND build_artifact_generation = ?)
         )`,
    )
    .bind(
      args.objectKey,
      args.executionGeneration,
      now,
      args.deploymentId,
      args.executionGeneration,
      args.objectKey,
      args.executionGeneration,
    );
  try {
    const results = await args.db.batch([...gcStatements, retainStatement]);
    if (results.at(-1)?.meta.changes === 1) {
      return;
    }
  } catch (error) {
    if (await isDeploymentBuildArtifactReferenceCommitted(args)) {
      return;
    }
    throw error;
  }
  if (await isDeploymentBuildArtifactReferenceCommitted(args)) {
    return;
  }
  throw new DeploymentStateConflictError((await requireDeployment(args.db, args.deploymentId)).status);
}

export async function claimApprovedDeployment(args: {
  db: D1Database;
  deploymentId: string;
  userId: string;
  connectionId: string;
  connectionGeneration: number;
  executionGeneration: number;
  now?: number;
}): Promise<Deployment> {
  const current = await requireDeploymentForUser(args.db, args.deploymentId, args.userId);
  if (current.connectionId !== args.connectionId || current.connectionGeneration !== args.connectionGeneration) {
    throw new DeploymentConnectionChangedError();
  }
  if (current.executionGeneration !== args.executionGeneration) {
    throw new DeploymentStateConflictError(current.status);
  }
  if (current.status !== 'approved' || !current.approvedDigest || current.approvedDigest !== current.planDigest) {
    throw new DeploymentStateConflictError(current.status);
  }
  const now = args.now ?? Date.now();
  await reconcileStaleActiveDeployments({
    db: args.db,
    userId: args.userId,
    staleBefore: now - STALE_ACTIVE_DEPLOYMENT_MS,
    now,
  });
  let result: D1Result;
  try {
    result = await args.db
      .prepare(
        `UPDATE deployments
         SET status = 'provisioning', updated_at = ?
         WHERE id = ? AND user_id = ? AND connection_id = ? AND status = 'approved'
           AND approved_digest = plan_digest
           AND connection_generation = ?
           AND execution_generation = ?
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
        args.executionGeneration,
        args.userId,
        args.deploymentId,
      )
      .run();
  } catch (error) {
    const committed = await readMatchingClaimedDeployment({ ...args, expected: current, updatedAt: now }).catch(
      () => null,
    );
    if (committed) {
      return committed;
    }
    throw error;
  }
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
    if (latest.executionGeneration !== args.executionGeneration) {
      throw new DeploymentStateConflictError(latest.status);
    }
    if (latest.status === 'approved') {
      throw new DeploymentConcurrencyLimitError();
    }
    throw new DeploymentStateConflictError(latest.status);
  }
  return { ...current, status: 'provisioning', updatedAt: now };
}

async function readMatchingClaimedDeployment(args: {
  db: D1Database;
  deploymentId: string;
  userId: string;
  connectionId: string;
  connectionGeneration: number;
  executionGeneration: number;
  expected: Deployment;
  updatedAt: number;
}): Promise<Deployment | null> {
  const latest = await requireDeploymentForUser(args.db, args.deploymentId, args.userId);
  return latest.status === 'provisioning' && isMatchingClaimedExecution(latest, args) ? latest : null;
}

function isMatchingClaimedExecution(
  deployment: Deployment,
  args: {
    deploymentId: string;
    userId: string;
    connectionId: string;
    connectionGeneration: number;
    executionGeneration: number;
    expected: Deployment;
    updatedAt: number;
  },
): boolean {
  const expected = args.expected;
  return (
    deployment.id === args.deploymentId &&
    deployment.userId === args.userId &&
    deployment.connectionId === args.connectionId &&
    deployment.connectionGeneration === args.connectionGeneration &&
    deployment.executionGeneration === args.executionGeneration &&
    deployment.updatedAt === args.updatedAt &&
    deployment.approvedAt === expected.approvedAt &&
    deployment.approvedDigest === expected.approvedDigest &&
    deployment.planDigest === expected.planDigest &&
    deployment.snapshotKey === expected.snapshotKey &&
    deployment.productionUrl === expected.productionUrl &&
    deployment.errorCode === expected.errorCode &&
    deployment.errorMessage === expected.errorMessage &&
    deployment.buildArtifactKey === expected.buildArtifactKey &&
    deployment.buildArtifactGeneration === expected.buildArtifactGeneration &&
    deployment.approvedDigest !== null &&
    deployment.approvedDigest === deployment.planDigest &&
    deployment.plan.deploymentId === expected.plan.deploymentId &&
    deployment.plan.deploymentId === deployment.id
  );
}

export async function prepareDeploymentRetry(args: {
  db: D1Database;
  deploymentId: string;
  userId: string;
  connectionId: string;
  connectionGeneration: number;
  executionGeneration: number;
  now?: number;
}): Promise<Deployment> {
  const now = args.now ?? Date.now();
  await reconcileStaleActiveDeployments({
    db: args.db,
    userId: args.userId,
    staleBefore: now - STALE_ACTIVE_DEPLOYMENT_MS,
    now,
  });
  const expected = await requireDeploymentForUser(args.db, args.deploymentId, args.userId);
  requireRetryableDeployment(expected, args);
  const cleanupStatement = prepareRetryBuildArtifactGcStatement(args.db, { expected, now });
  const retryStatement = args.db
    .prepare(
      `UPDATE deployments
       SET status = 'awaiting_approval', approved_digest = NULL, approved_at = NULL,
           build_artifact_key = NULL, build_artifact_generation = NULL,
           error_code = NULL, error_message = NULL, updated_at = ?
       WHERE id = ? AND user_id = ? AND connection_id = ? AND connection_generation = ?
         AND execution_generation = ?
         AND status = ? AND updated_at = ? AND plan_digest = ? AND snapshot_key IS ?
         AND approved_digest IS ? AND approved_at IS ?
         AND build_artifact_key IS ? AND build_artifact_generation IS ?
         AND production_url IS ? AND error_code IS ? AND error_message IS ?
         AND COALESCE(error_code, '') <> 'deployment_snapshot_released'`,
    )
    .bind(
      now,
      args.deploymentId,
      args.userId,
      args.connectionId,
      args.connectionGeneration,
      args.executionGeneration,
      expected.status,
      expected.updatedAt,
      expected.planDigest,
      expected.snapshotKey,
      expected.approvedDigest,
      expected.approvedAt,
      expected.buildArtifactKey,
      expected.buildArtifactGeneration,
      expected.productionUrl,
      expected.errorCode,
      expected.errorMessage,
    );
  let result: D1Result;
  try {
    [, result] = await args.db.batch([cleanupStatement, retryStatement]);
  } catch (error) {
    const committed = await readMatchingRetryCommit({ db: args.db, expected, now }).catch(() => null);
    if (committed) {
      return committed;
    }
    throw error;
  }
  if (result.meta.changes !== 1) {
    const committed = await readMatchingRetryCommit({ db: args.db, expected, now });
    if (committed) {
      return committed;
    }
    throw new DeploymentStateConflictError(
      (await requireDeploymentForUser(args.db, args.deploymentId, args.userId)).status,
    );
  }
  return {
    ...expected,
    status: 'awaiting_approval',
    approvedDigest: null,
    approvedAt: null,
    buildArtifactKey: null,
    buildArtifactGeneration: null,
    errorCode: null,
    errorMessage: null,
    updatedAt: now,
  };
}

export async function reconcileStaleActiveDeployments(args: {
  db: D1Database;
  userId: string;
  staleBefore: number;
  now?: number;
}): Promise<number> {
  const now = args.now ?? Date.now();
  const cleanupStatement = prepareStaleBuildArtifactGcStatement(args.db, { ...args, now });
  const reconcileStatement = args.db
    .prepare(
      `UPDATE deployments
       SET status = 'failed',
           build_artifact_key = NULL,
           build_artifact_generation = NULL,
           error_code = CASE
             WHEN status = 'building' THEN 'deployment_interrupted'
             ELSE 'cloudflare_cleanup_required'
           END,
           error_message = CASE
             WHEN status = 'building'
               THEN 'The isolated build stopped before completion. Retry the deployment.'
             ELSE 'Cloudflare resources may have changed before execution stopped. Retry this deployment to reconcile its approved plan.'
           END,
           updated_at = ?
       WHERE user_id = ?
         AND updated_at < ?
         AND status IN ('provisioning', 'building', 'deploying')`,
    )
    .bind(now, args.userId, args.staleBefore);
  const [, result] = await args.db.batch([cleanupStatement, reconcileStatement]);
  return result.meta.changes;
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

export async function transitionDeployment(args: {
  db: D1Database;
  deploymentId: string;
  executionGeneration: number;
  expectedStatus: DeploymentStatus;
  nextStatus: DeploymentStatus;
  productionUrl?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  now?: number;
}): Promise<void> {
  const now = args.now ?? Date.now();
  const terminal = isTerminalDeploymentStatus(args.nextStatus);
  const transitionStatement = args.db
    .prepare(
      `UPDATE deployments
       SET status = ?, production_url = ?, error_code = ?, error_message = ?,
           build_artifact_key = CASE WHEN ? THEN NULL ELSE build_artifact_key END,
           build_artifact_generation = CASE WHEN ? THEN NULL ELSE build_artifact_generation END,
           updated_at = ?
       WHERE id = ? AND execution_generation = ? AND status = ?`,
    )
    .bind(
      args.nextStatus,
      args.productionUrl ?? null,
      args.errorCode ?? null,
      args.errorMessage ?? null,
      terminal ? 1 : 0,
      terminal ? 1 : 0,
      now,
      args.deploymentId,
      args.executionGeneration,
      args.expectedStatus,
    );
  let result: D1Result;
  try {
    if (terminal) {
      const cleanupStatement = prepareTransitionBuildArtifactGcStatement(args.db, { ...args, now });
      const results = await args.db.batch([cleanupStatement, transitionStatement]);
      result = results[1];
    } else {
      result = await transitionStatement.run();
    }
  } catch (error) {
    if (await isDeploymentTransitionCommitted(args)) {
      return;
    }
    throw error;
  }
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
  const expected = await requireDeploymentForUser(args.db, args.deploymentId, args.userId);
  requireApprovableDeployment(expected, args);
  let result: D1Result;
  try {
    result = await args.db
      .prepare(
        `UPDATE deployments
       SET status = 'approved', approved_digest = ?, approved_at = ?,
           execution_generation = execution_generation + 1, updated_at = ?
       WHERE id = ? AND user_id = ? AND connection_id = ? AND connection_generation = ?
         AND execution_generation = ? AND status = ? AND updated_at = ?
         AND plan_digest = ? AND snapshot_key IS ?
         AND approved_digest IS ? AND approved_at IS ?
         AND build_artifact_key IS ? AND build_artifact_generation IS ?
         AND production_url IS ? AND error_code IS ? AND error_message IS ?`,
      )
      .bind(
        args.approvedDigest,
        now,
        now,
        args.deploymentId,
        args.userId,
        args.connectionId,
        args.connectionGeneration,
        expected.executionGeneration,
        expected.status,
        expected.updatedAt,
        expected.planDigest,
        expected.snapshotKey,
        expected.approvedDigest,
        expected.approvedAt,
        expected.buildArtifactKey,
        expected.buildArtifactGeneration,
        expected.productionUrl,
        expected.errorCode,
        expected.errorMessage,
      )
      .run();
  } catch (error) {
    const committed = await readMatchingApprovalCommit({
      db: args.db,
      expected,
      approvedDigest: args.approvedDigest,
      now,
    }).catch(() => null);
    if (committed) {
      return committed;
    }
    throw error;
  }
  if (result.meta.changes !== 1) {
    const committed = await readMatchingApprovalCommit({
      db: args.db,
      expected,
      approvedDigest: args.approvedDigest,
      now,
    });
    if (committed) {
      return committed;
    }
    const current = await requireDeploymentForUser(args.db, args.deploymentId, args.userId);
    if (current.planDigest !== args.approvedDigest) {
      throw new DeploymentApprovalDigestMismatchError();
    }
    if (current.connectionId !== args.connectionId || current.connectionGeneration !== args.connectionGeneration) {
      throw new DeploymentConnectionChangedError();
    }
    throw new DeploymentStateConflictError(current.status);
  }
  return {
    ...expected,
    executionGeneration: expected.executionGeneration + 1,
    status: 'approved',
    approvedDigest: args.approvedDigest,
    approvedAt: now,
    updatedAt: now,
  };
}

function requireApprovableDeployment(
  deployment: Deployment,
  args: {
    connectionId: string;
    connectionGeneration: number;
    approvedDigest: string;
  },
): void {
  if (deployment.planDigest !== args.approvedDigest) {
    throw new DeploymentApprovalDigestMismatchError();
  }
  if (deployment.connectionId !== args.connectionId || deployment.connectionGeneration !== args.connectionGeneration) {
    throw new DeploymentConnectionChangedError();
  }
  if (
    deployment.status !== 'awaiting_approval' ||
    !Number.isSafeInteger(deployment.executionGeneration) ||
    deployment.executionGeneration < 0 ||
    deployment.executionGeneration >= Number.MAX_SAFE_INTEGER ||
    deployment.snapshotKey === null ||
    deployment.approvedDigest !== null ||
    deployment.approvedAt !== null ||
    deployment.buildArtifactKey !== null ||
    deployment.buildArtifactGeneration !== null ||
    deployment.plan.deploymentId !== deployment.id
  ) {
    throw new DeploymentStateConflictError(deployment.status);
  }
}

async function readMatchingApprovalCommit(args: {
  db: D1Database;
  expected: Deployment;
  approvedDigest: string;
  now: number;
}): Promise<Deployment | null> {
  const current = await requireDeploymentForUser(args.db, args.expected.id, args.expected.userId);
  return current.executionGeneration === args.expected.executionGeneration + 1 &&
    current.status === 'approved' &&
    current.approvedDigest === args.approvedDigest &&
    current.approvedAt === args.now &&
    current.updatedAt === args.now &&
    current.buildArtifactKey === args.expected.buildArtifactKey &&
    current.buildArtifactGeneration === args.expected.buildArtifactGeneration &&
    hasSameDeploymentIdentity(current, args.expected) &&
    hasSameDeploymentOutcome(current, args.expected)
    ? current
    : null;
}

function requireRetryableDeployment(
  deployment: Deployment,
  args: {
    connectionId: string;
    connectionGeneration: number;
    executionGeneration: number;
  },
): void {
  if (deployment.connectionId !== args.connectionId || deployment.connectionGeneration !== args.connectionGeneration) {
    throw new DeploymentConnectionChangedError();
  }
  if (
    deployment.executionGeneration !== args.executionGeneration ||
    (deployment.status !== 'failed' && deployment.status !== 'canceled') ||
    deployment.snapshotKey === null ||
    deployment.errorCode === 'deployment_snapshot_released' ||
    deployment.plan.deploymentId !== deployment.id ||
    (deployment.buildArtifactKey === null) !== (deployment.buildArtifactGeneration === null) ||
    (deployment.buildArtifactGeneration !== null &&
      deployment.buildArtifactGeneration !== deployment.executionGeneration)
  ) {
    throw new DeploymentStateConflictError(deployment.status);
  }
}

async function readMatchingRetryCommit(args: {
  db: D1Database;
  expected: Deployment;
  now: number;
}): Promise<Deployment | null> {
  const current = await requireDeploymentForUser(args.db, args.expected.id, args.expected.userId);
  return current.executionGeneration === args.expected.executionGeneration &&
    current.status === 'awaiting_approval' &&
    current.approvedDigest === null &&
    current.approvedAt === null &&
    current.buildArtifactKey === null &&
    current.buildArtifactGeneration === null &&
    current.productionUrl === args.expected.productionUrl &&
    current.errorCode === null &&
    current.errorMessage === null &&
    current.updatedAt === args.now &&
    hasSameDeploymentIdentity(current, args.expected)
    ? current
    : null;
}

function hasSameDeploymentIdentity(current: Deployment, expected: Deployment): boolean {
  return (
    current.id === expected.id &&
    current.chatId === expected.chatId &&
    current.userId === expected.userId &&
    current.connectionId === expected.connectionId &&
    current.connectionGeneration === expected.connectionGeneration &&
    current.snapshotKey === expected.snapshotKey &&
    current.planDigest === expected.planDigest &&
    current.plan.deploymentId === expected.plan.deploymentId &&
    current.plan.deploymentId === current.id &&
    current.createdAt === expected.createdAt
  );
}

function hasSameDeploymentOutcome(current: Deployment, expected: Deployment): boolean {
  return (
    current.productionUrl === expected.productionUrl &&
    current.errorCode === expected.errorCode &&
    current.errorMessage === expected.errorMessage
  );
}

function prepareTransitionBuildArtifactGcStatement(
  db: D1Database,
  args: {
    deploymentId: string;
    executionGeneration: number;
    expectedStatus: DeploymentStatus;
    now: number;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO object_gc_candidates (storage_key, not_before, created_at, attempts)
       SELECT build_artifact_key, ?, ?, 0
       FROM deployments
       WHERE id = ? AND execution_generation = ? AND status = ?
         AND build_artifact_key IS NOT NULL
         AND build_artifact_generation = ?
       ON CONFLICT(storage_key) DO UPDATE SET
         not_before = MAX(object_gc_candidates.not_before, excluded.not_before)`,
    )
    .bind(
      args.now + OBJECT_GC_GRACE_PERIOD_MS,
      args.now,
      args.deploymentId,
      args.executionGeneration,
      args.expectedStatus,
      args.executionGeneration,
    );
}

function prepareRetryBuildArtifactGcStatement(
  db: D1Database,
  args: { expected: Deployment; now: number },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO object_gc_candidates (storage_key, not_before, created_at, attempts)
       SELECT build_artifact_key, ?, ?, 0
       FROM deployments
       WHERE id = ? AND user_id = ? AND connection_id = ? AND connection_generation = ?
         AND execution_generation = ?
         AND status = ? AND updated_at = ? AND plan_digest = ? AND snapshot_key IS ?
         AND approved_digest IS ? AND approved_at IS ?
         AND build_artifact_key IS ? AND build_artifact_generation IS ?
         AND production_url IS ? AND error_code IS ? AND error_message IS ?
         AND COALESCE(error_code, '') <> 'deployment_snapshot_released'
         AND build_artifact_key IS NOT NULL
       ON CONFLICT(storage_key) DO UPDATE SET
         not_before = MAX(object_gc_candidates.not_before, excluded.not_before)`,
    )
    .bind(
      args.now + OBJECT_GC_GRACE_PERIOD_MS,
      args.now,
      args.expected.id,
      args.expected.userId,
      args.expected.connectionId,
      args.expected.connectionGeneration,
      args.expected.executionGeneration,
      args.expected.status,
      args.expected.updatedAt,
      args.expected.planDigest,
      args.expected.snapshotKey,
      args.expected.approvedDigest,
      args.expected.approvedAt,
      args.expected.buildArtifactKey,
      args.expected.buildArtifactGeneration,
      args.expected.productionUrl,
      args.expected.errorCode,
      args.expected.errorMessage,
    );
}

function prepareStaleBuildArtifactGcStatement(
  db: D1Database,
  args: { userId: string; staleBefore: number; now: number },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO object_gc_candidates (storage_key, not_before, created_at, attempts)
       SELECT build_artifact_key, ?, ?, 0
       FROM deployments
       WHERE user_id = ? AND updated_at < ?
         AND status IN ('provisioning', 'building', 'deploying')
         AND build_artifact_key IS NOT NULL
         AND build_artifact_generation = execution_generation
       ON CONFLICT(storage_key) DO UPDATE SET
         not_before = MAX(object_gc_candidates.not_before, excluded.not_before)`,
    )
    .bind(args.now + OBJECT_GC_GRACE_PERIOD_MS, args.now, args.userId, args.staleBefore);
}

async function isDeploymentBuildArtifactReferenceCommitted(args: {
  db: D1Database;
  deploymentId: string;
  executionGeneration: number;
  objectKey: string;
}): Promise<boolean> {
  try {
    const current = await requireDeployment(args.db, args.deploymentId);
    return (
      current.executionGeneration === args.executionGeneration &&
      current.buildArtifactKey === args.objectKey &&
      current.buildArtifactGeneration === args.executionGeneration &&
      (current.status === 'provisioning' || current.status === 'building') &&
      current.approvedDigest === current.planDigest &&
      current.plan.deploymentId === current.id
    );
  } catch {
    return false;
  }
}

async function isDeploymentTransitionCommitted(args: {
  db: D1Database;
  deploymentId: string;
  executionGeneration: number;
  nextStatus: DeploymentStatus;
  productionUrl?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}): Promise<boolean> {
  try {
    const current = await requireDeployment(args.db, args.deploymentId);
    return (
      current.executionGeneration === args.executionGeneration &&
      current.status === args.nextStatus &&
      current.productionUrl === (args.productionUrl ?? null) &&
      current.errorCode === (args.errorCode ?? null) &&
      current.errorMessage === (args.errorMessage ?? null) &&
      current.approvedDigest === current.planDigest &&
      current.plan.deploymentId === current.id &&
      (!isTerminalDeploymentStatus(args.nextStatus) ||
        (current.buildArtifactKey === null && current.buildArtifactGeneration === null))
    );
  } catch {
    return false;
  }
}

function isTerminalDeploymentStatus(status: DeploymentStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'canceled';
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
    executionGeneration: row.execution_generation,
    buildArtifactKey: row.build_artifact_key,
    buildArtifactGeneration: row.build_artifact_generation,
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
