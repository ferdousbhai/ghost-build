import { getSandbox } from '@cloudflare/sandbox';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import type { DeploymentSandbox } from './deployment-sandbox';
import { destroySandboxWithRetries, withSandboxRpcTimeout } from './sandbox-lifecycle';

const ACTIVE_LEASE_MS = 3 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 60 * 1000;
const CLEANUP_RETRY_MS = 60 * 1000;
const CLEANUP_CLAIM_MS = 2 * 60 * 1000;
const CLEANUP_SWEEP_LIMIT = 4;
const MAX_ERROR_BYTES = 1_000;

export const SANDBOX_CLEANUP_CRON = '* * * * *';

const logger = createScopedLogger('SandboxCleanup');

type SandboxHandle = {
  destroy(): Promise<unknown>;
  setKeepAlive(value: boolean): Promise<unknown>;
};

type SandboxCleanupCandidate = {
  sandbox_id: string;
  lease_token: string;
  operation: string;
  status: 'active' | 'cleanup';
  not_before: number;
};

export type TrackedSandboxLifecycle = {
  destroy(): Promise<void>;
  stopHeartbeat(): void;
};

export async function trackSandboxLifecycle(args: {
  db: D1Database;
  sandbox: SandboxHandle;
  sandboxId: string;
  operation: string;
}): Promise<TrackedSandboxLifecycle> {
  const leaseToken = crypto.randomUUID();
  const createdAt = Date.now();
  await args.db
    .prepare(
      `INSERT INTO sandbox_cleanup_candidates
        (sandbox_id, lease_token, operation, status, not_before, created_at, updated_at, attempts, last_error)
       VALUES (?, ?, ?, 'active', ?, ?, ?, 0, NULL)
       ON CONFLICT(sandbox_id) DO UPDATE SET
         lease_token = excluded.lease_token,
         operation = excluded.operation,
         status = 'active',
         not_before = excluded.not_before,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         attempts = 0,
         last_error = NULL`,
    )
    .bind(args.sandboxId, leaseToken, args.operation, createdAt + ACTIVE_LEASE_MS, createdAt, createdAt)
    .run();

  let heartbeat: ReturnType<typeof setInterval> | undefined = setInterval(() => {
    const now = Date.now();
    void args.db
      .prepare(
        `UPDATE sandbox_cleanup_candidates
         SET not_before = ?, updated_at = ?
         WHERE sandbox_id = ? AND lease_token = ? AND status = 'active'`,
      )
      .bind(now + ACTIVE_LEASE_MS, now, args.sandboxId, leaseToken)
      .run()
      .catch((error) =>
        logger.warn('Unable to renew active sandbox cleanup lease', { sandboxId: args.sandboxId, error }),
      );
  }, HEARTBEAT_INTERVAL_MS);
  let destroyPromise: Promise<void> | undefined;

  const stopHeartbeat = () => {
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
  };

  return {
    stopHeartbeat,
    destroy() {
      stopHeartbeat();
      destroyPromise ??= destroyTrackedSandbox({ ...args, leaseToken });
      return destroyPromise;
    },
  };
}

export async function destroyRegisteredSandbox(
  env: Pick<Env, 'DB' | 'DeploymentSandbox'>,
  sandboxId: string,
  operation: string,
): Promise<boolean> {
  const sandbox = getSandbox(env.DeploymentSandbox as DurableObjectNamespace<DeploymentSandbox>, sandboxId, {
    transport: 'rpc',
    enableDefaultSession: false,
    normalizeId: true,
  });
  const now = Date.now();
  await queueImmediateCleanup(env.DB, sandboxId, operation, now).catch((error) =>
    logger.warn('Unable to persist registered sandbox cleanup request', { sandboxId, error }),
  );
  const result = await destroySandboxWithRetries(sandbox, operation);
  if (result.destroyed) {
    await env.DB.prepare('DELETE FROM sandbox_cleanup_candidates WHERE sandbox_id = ?')
      .bind(sandboxId)
      .run()
      .catch((error) =>
        logger.warn('Destroyed registered sandbox remains queued for idempotent reconciliation', {
          sandboxId,
          error,
        }),
      );
    return true;
  }
  await disableKeepAliveBestEffort(sandbox, sandboxId);
  await deferCleanup(env.DB, sandboxId, null, result.error, Date.now());
  return false;
}

export async function sweepSandboxCleanupCandidates(
  env: Pick<Env, 'DB' | 'DeploymentSandbox'>,
  options: { limit?: number; now?: number } = {},
): Promise<number> {
  const now = options.now ?? Date.now();
  const limit = Math.max(1, Math.min(options.limit ?? CLEANUP_SWEEP_LIMIT, CLEANUP_SWEEP_LIMIT));
  const rows = await env.DB.prepare(
    `SELECT sandbox_id, lease_token, operation, status, not_before
     FROM sandbox_cleanup_candidates
     WHERE not_before <= ?
     ORDER BY not_before, sandbox_id
     LIMIT ?`,
  )
    .bind(now, limit)
    .all<SandboxCleanupCandidate>();
  let destroyed = 0;

  for (const candidate of rows.results) {
    const claim = await env.DB.prepare(
      `UPDATE sandbox_cleanup_candidates
         SET status = 'cleanup', not_before = ?, updated_at = ?
         WHERE sandbox_id = ? AND lease_token = ? AND not_before = ? AND not_before <= ?`,
    )
      .bind(now + CLEANUP_CLAIM_MS, now, candidate.sandbox_id, candidate.lease_token, candidate.not_before, now)
      .run();
    if (claim.meta.changes !== 1) {
      continue;
    }
    const sandbox = getSandbox(
      env.DeploymentSandbox as DurableObjectNamespace<DeploymentSandbox>,
      candidate.sandbox_id,
      { transport: 'rpc', enableDefaultSession: false, normalizeId: true },
    );
    const result = await destroySandboxWithRetries(sandbox, candidate.operation);
    if (result.destroyed) {
      await env.DB.prepare('DELETE FROM sandbox_cleanup_candidates WHERE sandbox_id = ? AND lease_token = ?')
        .bind(candidate.sandbox_id, candidate.lease_token)
        .run();
      destroyed += 1;
      continue;
    }
    await disableKeepAliveBestEffort(sandbox, candidate.sandbox_id);
    await deferCleanup(env.DB, candidate.sandbox_id, candidate.lease_token, result.error, Date.now());
  }
  return destroyed;
}

export async function sweepSandboxCleanupCandidatesBestEffort(
  env: Pick<Env, 'DB' | 'DeploymentSandbox'>,
): Promise<void> {
  try {
    const destroyed = await sweepSandboxCleanupCandidates(env);
    if (destroyed > 0) {
      logger.info('Destroyed abandoned sandboxes', { count: destroyed });
    }
  } catch (error) {
    logger.warn('Unable to sweep abandoned sandboxes', { error });
  }
}

async function destroyTrackedSandbox(args: {
  db: D1Database;
  sandbox: SandboxHandle;
  sandboxId: string;
  operation: string;
  leaseToken: string;
}): Promise<void> {
  const now = Date.now();
  await requestCleanup(args.db, args.sandboxId, args.leaseToken, now).catch((error) =>
    logger.warn('Unable to persist sandbox cleanup request', { sandboxId: args.sandboxId, error }),
  );
  const result = await destroySandboxWithRetries(args.sandbox, args.operation);
  if (result.destroyed) {
    await args.db
      .prepare('DELETE FROM sandbox_cleanup_candidates WHERE sandbox_id = ? AND lease_token = ?')
      .bind(args.sandboxId, args.leaseToken)
      .run()
      .catch((error) =>
        logger.warn('Destroyed sandbox remains queued for idempotent reconciliation', {
          sandboxId: args.sandboxId,
          error,
        }),
      );
    return;
  }
  await disableKeepAliveBestEffort(args.sandbox, args.sandboxId);
  await deferCleanup(args.db, args.sandboxId, args.leaseToken, result.error, Date.now()).catch((error) =>
    logger.warn('Unable to reschedule failed sandbox cleanup', { sandboxId: args.sandboxId, error }),
  );
}

function requestCleanup(db: D1Database, sandboxId: string, leaseToken: string | null, now: number): Promise<D1Result> {
  const tokenPredicate = leaseToken === null ? '' : ' AND lease_token = ?';
  const statement = db.prepare(
    `UPDATE sandbox_cleanup_candidates
     SET status = 'cleanup', not_before = ?, updated_at = ?
     WHERE sandbox_id = ?${tokenPredicate}`,
  );
  return (
    leaseToken === null ? statement.bind(now, now, sandboxId) : statement.bind(now, now, sandboxId, leaseToken)
  ).run();
}

function queueImmediateCleanup(db: D1Database, sandboxId: string, operation: string, now: number): Promise<D1Result> {
  return db
    .prepare(
      `INSERT INTO sandbox_cleanup_candidates
        (sandbox_id, lease_token, operation, status, not_before, created_at, updated_at, attempts, last_error)
       VALUES (?, ?, ?, 'cleanup', ?, ?, ?, 0, NULL)
       ON CONFLICT(sandbox_id) DO UPDATE SET
         operation = excluded.operation,
         status = 'cleanup',
         not_before = excluded.not_before,
         updated_at = excluded.updated_at`,
    )
    .bind(sandboxId, crypto.randomUUID(), operation, now, now, now)
    .run();
}

function deferCleanup(
  db: D1Database,
  sandboxId: string,
  leaseToken: string | null,
  error: unknown,
  now: number,
): Promise<D1Result> {
  const tokenPredicate = leaseToken === null ? '' : ' AND lease_token = ?';
  const statement = db.prepare(
    `UPDATE sandbox_cleanup_candidates
     SET status = 'cleanup', not_before = ?, updated_at = ?, attempts = attempts + 1, last_error = ?
     WHERE sandbox_id = ?${tokenPredicate}`,
  );
  return (
    leaseToken === null
      ? statement.bind(now + CLEANUP_RETRY_MS, now, errorMessage(error), sandboxId)
      : statement.bind(now + CLEANUP_RETRY_MS, now, errorMessage(error), sandboxId, leaseToken)
  ).run();
}

async function disableKeepAliveBestEffort(sandbox: SandboxHandle, sandboxId: string): Promise<void> {
  try {
    await withSandboxRpcTimeout(sandbox.setKeepAlive(false), 10_000, 'Sandbox keepAlive disable');
  } catch (error) {
    logger.warn('Unable to disable keepAlive after sandbox cleanup failure', { sandboxId, error });
  }
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(-MAX_ERROR_BYTES);
}
