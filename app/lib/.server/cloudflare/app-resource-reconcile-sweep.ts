import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import {
  APP_RESOURCE_RECONCILE_MODE,
  reconcileAppResources,
  type OrphanedAppResourceKind,
} from '~/lib/cloudflare/data/app-resource-reconcile.server';
import { D1CloudflareCredentialVault } from './cloudflare-credential-vault';
import { UserCloudflareAccountApi } from './user-account-api';

/**
 * Sweep every connected Cloudflare account for app resources no live Worker anchors.
 *
 * The sweep used to run inside each user's own workspace runtime, where two things went wrong:
 * a collector hosted inside the thing being collected cannot outlive that thing's deletion, and
 * its logs landed in the user's account, where nobody here could read the diff it proposed.
 * It then ran on a separate operations Worker that had to ask the control plane for each report
 * over RPC, because the credentials never leave here. Running it here directly removes that hop.
 *
 * There is no operator dashboard any more, so every run leaves a receipt in
 * `app_resource_reconcile_runs` for local tooling to read.
 */

/** One sweep looks at this many connected accounts, oldest first. */
const RECONCILE_USER_LIMIT = 100;

/** A very large diff belongs in the logs, not in one D1 row. `orphans_found` stays exact. */
const RECORDED_ORPHAN_LIMIT = 200;

const logger = createScopedLogger('AppResourceReconcileSweep');

type ConnectedAccountRow = {
  user_id: string;
  account_id: string;
  credential_handle: string;
};

type RecordedOrphan = { userId: string; kind: OrphanedAppResourceKind; name: string };

type AppResourceReconcileSweepSummary = {
  runId: string;
  users: number;
  failures: number;
  scanned: number;
  orphans: number;
  deleted: number;
  skippedListings: Set<string>;
};

export async function runAppResourceReconciliation(
  env: Env,
  now = Date.now(),
): Promise<AppResourceReconcileSweepSummary> {
  const runId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO app_resource_reconcile_runs (id, status, mode, started_at)
     VALUES (?, 'running', ?, ?)`,
  )
    .bind(runId, APP_RESOURCE_RECONCILE_MODE, now)
    .run();

  const summary: AppResourceReconcileSweepSummary = {
    runId,
    users: 0,
    failures: 0,
    scanned: 0,
    orphans: 0,
    deleted: 0,
    skippedListings: new Set<string>(),
  };
  const recorded: RecordedOrphan[] = [];

  try {
    const accounts = await env.DB.prepare(
      `SELECT users.id AS user_id, connections.account_id AS account_id,
              connections.credential_handle AS credential_handle
         FROM "user" AS users
         JOIN cloudflare_connections AS connections ON connections.user_id = users.id
         WHERE connections.status = 'active' AND connections.credential_handle IS NOT NULL
         ORDER BY users.createdAt
         LIMIT ?`,
    )
      .bind(RECONCILE_USER_LIMIT)
      .all<ConnectedAccountRow>();

    // Sequentially: a sweep reads a whole Cloudflare account, and nothing here is in a hurry.
    for (const account of accounts.results) {
      summary.users += 1;
      const report = await reconcileConnectedAccount(env, account, now);
      if (!report) {
        summary.failures += 1;
        continue;
      }
      summary.scanned += report.scanned;
      summary.orphans += report.orphans.length;
      summary.deleted += report.deleted.length;
      for (const listing of report.skippedListings) {
        summary.skippedListings.add(listing);
      }
      for (const resource of report.orphans.slice(0, RECORDED_ORPHAN_LIMIT - recorded.length)) {
        recorded.push({ userId: account.user_id, kind: resource.kind, name: resource.name });
      }
    }
    await finishRun(env.DB, runId, 'ok', summary, recorded, null);
  } catch (error) {
    await finishRun(env.DB, runId, 'error', summary, recorded, cleanError(error)).catch((receiptError) => {
      // The run receipt is the only record an operator reads. Losing it leaves the row at
      // `running`, which the ops report shows as a crashed sweep, so name both failures here.
      logger.error(
        `Unable to record the failure of app resource reconcile run ${runId}`,
        receiptError instanceof Error ? receiptError.message : String(receiptError),
        cleanError(error),
      );
    });
    throw error;
  }

  if (summary.orphans > 0 || summary.failures > 0 || summary.skippedListings.size > 0) {
    // The diff an operator has to read before enforcement can be turned on.
    logger.warn(
      `Reconcile run ${runId} in ${APP_RESOURCE_RECONCILE_MODE} mode: ${summary.orphans} orphan(s) across ` +
        `${summary.scanned} scanned resource(s) and ${summary.users} account(s), ${summary.failures} unreadable` +
        `${summary.skippedListings.size > 0 ? `, without reading ${[...summary.skippedListings].join(', ')}` : ''}`,
    );
  }
  return summary;
}

async function reconcileConnectedAccount(env: Env, account: ConnectedAccountRow, now: number) {
  try {
    const accessToken = await D1CloudflareCredentialVault.fromEnv(env).resolve(account.credential_handle);
    return await reconcileAppResources(new UserCloudflareAccountApi(account.account_id, accessToken), {
      now,
      mode: APP_RESOURCE_RECONCILE_MODE,
    });
  } catch {
    // The account is named so the operator can go and look; the reason never carries a token.
    logger.warn(`Unable to reconcile app resources for user ${account.user_id}`);
    return null;
  }
}

async function finishRun(
  db: D1Database,
  runId: string,
  status: 'ok' | 'error',
  summary: AppResourceReconcileSweepSummary,
  orphans: RecordedOrphan[],
  error: string | null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE app_resource_reconcile_runs
       SET status = ?, completed_at = ?, users_scanned = ?, users_failed = ?, resources_scanned = ?,
           orphans_found = ?, orphans_json = ?, deleted_count = ?, listing_skipped = ?,
           skipped_listings_json = ?, error = ?
       WHERE id = ?`,
    )
    .bind(
      status,
      Date.now(),
      summary.users,
      summary.failures,
      summary.scanned,
      summary.orphans,
      JSON.stringify(orphans),
      summary.deleted,
      summary.skippedListings.size > 0 ? 1 : 0,
      summary.skippedListings.size > 0 ? JSON.stringify([...summary.skippedListings].sort()) : null,
      error,
      runId,
    )
    .run();
}

function cleanError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replaceAll(/\s+/g, ' ').trim().slice(0, 2_000);
}
