import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { deploymentPlanResourceName, parseDeploymentPlanJson } from '~/lib/.server/cloudflare/deployment-plan';
import { createUserAccountApi } from '~/lib/.server/cloudflare/user-workspace-deployment-executor';
import type { UserCloudflareAccountApi } from '~/lib/.server/cloudflare/user-account-api';
import { AGENT_GC_GRACE_PERIOD_MS, AGENT_GC_RETRY_BASE_MS } from './agent-gc.server';

const APP_RESOURCE_GC_SWEEP_LIMIT = 2;
const APP_RESOURCE_GC_RETRY_MAX_MS = 60 * 60 * 1000;

const logger = createScopedLogger('CloudflareAppResourceGc');

type AppResourceGcCandidateRow = {
  chat_id: string;
  not_before: number;
  attempts: number;
};

type DeploymentPlanRow = {
  plan_json: string;
};

export function prepareAppResourceGcCandidateStatement(
  db: D1Database,
  args: { initialId: string; ownerId: string; now?: number; requireEmpty?: boolean },
): D1PreparedStatement {
  const now = args.now ?? Date.now();
  const emptyClause = args.requireEmpty
    ? `AND NOT EXISTS (
         SELECT 1 FROM chat_transcripts
         WHERE chat_transcripts.chat_id = chats.id AND chat_transcripts.head_revision > 0
       )`
    : '';
  return db
    .prepare(
      `INSERT INTO app_resource_gc_candidates (chat_id, not_before, created_at, attempts)
       SELECT chats.id, ?, ?, 0
       FROM chats
       WHERE chats.initial_id = ? AND chats.creator_id = ? AND chats.is_deleted = 0
         ${emptyClause}
       ON CONFLICT(chat_id) DO UPDATE SET
         not_before = MIN(app_resource_gc_candidates.not_before, excluded.not_before)`,
    )
    .bind(now + AGENT_GC_GRACE_PERIOD_MS, now, args.initialId, args.ownerId);
}

export async function sweepAppResourceGcCandidates(
  env: Pick<
    Env,
    | 'DB'
    | 'GHOSTBUILD_CONTROL_PLANE_ENDPOINT'
    | 'CONTROL_PLANE_SECRET'
    | 'GHOSTBUILD_USER_ID'
    | 'GHOSTBUILD_CONNECTION_ID'
    | 'GHOSTBUILD_CONNECTION_GENERATION'
    | 'CLOUDFLARE_ACCOUNT_ID'
  >,
  options: { limit?: number; now?: number; accountApi?: AppResourceCleanupApi } = {},
): Promise<number> {
  const limit = Math.max(1, Math.min(options.limit ?? APP_RESOURCE_GC_SWEEP_LIMIT, APP_RESOURCE_GC_SWEEP_LIMIT));
  const now = options.now ?? Date.now();
  const result = await env.DB.prepare(
    `SELECT candidates.chat_id, candidates.not_before, candidates.attempts
     FROM app_resource_gc_candidates AS candidates
     INNER JOIN chats ON chats.id = candidates.chat_id
     WHERE chats.is_deleted = 1 AND candidates.not_before <= ?
     ORDER BY candidates.not_before, candidates.chat_id
     LIMIT ?`,
  )
    .bind(now, limit)
    .all<AppResourceGcCandidateRow>();
  if (result.results.length === 0) {
    return 0;
  }

  const accountApi = options.accountApi ?? (await createUserAccountApi(env, fetch));
  let completed = 0;
  for (const candidate of result.results) {
    completed += await cleanupCandidate(env.DB, accountApi, candidate, now);
  }
  return completed;
}

export async function sweepAppResourceGcCandidatesBestEffort(
  env: Parameters<typeof sweepAppResourceGcCandidates>[0],
): Promise<void> {
  try {
    await sweepAppResourceGcCandidates(env);
  } catch {
    logger.warn('Unable to sweep deferred app Cloudflare resources');
  }
}

type AppResourceCleanupApi = Pick<
  UserCloudflareAccountApi,
  'deleteManagedWorker' | 'deleteD1Database' | 'deleteR2Bucket' | 'deleteKvNamespace'
>;

async function cleanupCandidate(
  db: D1Database,
  accountApi: AppResourceCleanupApi,
  candidate: AppResourceGcCandidateRow,
  now: number,
): Promise<number> {
  try {
    const plans = await db
      .prepare(
        `SELECT plan_json
         FROM deployments
         WHERE chat_id = ?
         ORDER BY created_at, id`,
      )
      .bind(candidate.chat_id)
      .all<DeploymentPlanRow>();
    for (const row of plans.results) {
      const plan = parsePlanForCleanup(row.plan_json);
      if (!plan) {
        // A plan this build cannot parse will never become parseable, so retrying
        // would stall the candidate forever and block the deployments behind it.
        // Leave the provider resources for the reconciliation sweep to report.
        logger.warn('Skipped a deployment whose stored plan this build cannot parse');
        continue;
      }
      if (!(await cleanupDeploymentPlan(accountApi, plan))) {
        await rescheduleCandidate(db, candidate, now, false);
        return 0;
      }
    }
    const result = await db
      .prepare(
        `DELETE FROM app_resource_gc_candidates
         WHERE chat_id = ? AND not_before = ?`,
      )
      .bind(candidate.chat_id, candidate.not_before)
      .run();
    return result.meta.changes > 0 ? 1 : 0;
  } catch {
    await rescheduleCandidate(db, candidate, now, true);
    logger.warn('Unable to remove deferred app Cloudflare resources');
    return 0;
  }
}

/** Parse a stored plan, or null when this build's schema no longer accepts it. */
function parsePlanForCleanup(planJson: string): ReturnType<typeof parseDeploymentPlanJson> | null {
  try {
    return parseDeploymentPlanJson(planJson);
  } catch {
    return null;
  }
}

async function cleanupDeploymentPlan(
  accountApi: AppResourceCleanupApi,
  plan: ReturnType<typeof parseDeploymentPlanJson>,
): Promise<boolean> {
  const workerName = deploymentPlanResourceName(plan, 'worker', 'app');
  if (!workerName) {
    throw new Error('Deployment cleanup plan has no valid Worker.');
  }
  await accountApi.deleteManagedWorker(workerName);

  for (const logicalName of ['DB', 'AGENT_SECURITY_DB'] as const) {
    const name = deploymentPlanResourceName(plan, 'd1', logicalName);
    if (name) {
      await accountApi.deleteD1Database(name);
    }
  }
  const kvName = deploymentPlanResourceName(plan, 'kv', 'APP_CACHE');
  if (kvName) {
    await accountApi.deleteKvNamespace(kvName);
  }
  const r2Name = deploymentPlanResourceName(plan, 'r2', 'APP_STORAGE');
  return r2Name ? accountApi.deleteR2Bucket(r2Name) : true;
}

function rescheduleCandidate(
  db: D1Database,
  candidate: AppResourceGcCandidateRow,
  now: number,
  failed: boolean,
): Promise<D1Result> {
  const retryAt = now + retryDelay(failed ? candidate.attempts : 0);
  return db
    .prepare(
      `UPDATE app_resource_gc_candidates
       SET attempts = ?, not_before = ?
       WHERE chat_id = ? AND not_before = ?`,
    )
    .bind(failed ? candidate.attempts + 1 : candidate.attempts, retryAt, candidate.chat_id, candidate.not_before)
    .run();
}

function retryDelay(attempts: number): number {
  return Math.min(AGENT_GC_RETRY_BASE_MS * 2 ** Math.min(attempts, 7), APP_RESOURCE_GC_RETRY_MAX_MS);
}
