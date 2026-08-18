import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { D1CloudflareCredentialVault } from './cloudflare-credential-vault';
import { UserCloudflareAccountApi } from './user-account-api';
import {
  listOutstandingUserWorkspaceRuntimeResources,
  markUserWorkspaceRuntimeResourcesReclaimed,
  type UserWorkspaceRuntimeResource,
} from './user-workspace-runtime-resources';

/**
 * Reclaim the Cloudflare resources of a workspace runtime nobody is coming back for.
 *
 * Provisioning is resumable by construction: every step is an `ensure`, so a retry adopts the
 * database and Worker a failed attempt left behind rather than duplicating them. That makes
 * cleanup-on-failure the wrong instinct - it would delete state the next attempt wants, and on a
 * runtime upgrade, which re-provisions under the same names, it would delete a live workspace's
 * database. Leftovers are only garbage once nobody retries, and that is a fact about elapsed
 * time, not about the attempt that failed.
 *
 * So this runs on its own, long after the fact, and it is anchored on
 * `user_workspace_runtime_resources` rather than on the `ghostbuild-<hex16>` name shape. The
 * account-anchored app sweep refuses that shape on purpose: a prefix match over it matches every
 * live workspace database in the account.
 */

/** A workspace runtime that has not moved in this long is not being retried. */
export const WORKSPACE_RUNTIME_ABANDONED_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Reporting only, until an operator has read a run of real candidates. Deletion is one reviewed
 * edit away rather than a runtime toggle nobody can audit after the fact, the same way
 * `APP_RESOURCE_RECONCILE_MODE` is.
 */
const WORKSPACE_RUNTIME_RECLAIM_MODE: 'report' | 'enforce' = 'report';

/** One run considers this many abandoned runtimes; each one reads and writes a whole account. */
const RECLAIM_USER_LIMIT = 20;

const logger = createScopedLogger('WorkspaceRuntimeReclaim');

type AbandonedRuntimeRow = {
  user_id: string;
  account_id: string;
  credential_handle: string;
  status: string;
  updated_at: number;
};

/** Why a candidate was left alone. Every one of these is a thing an operator may need to fix. */
type RetentionReason = 'unrecorded' | 'holds_user_data' | 'unreadable';

type WorkspaceRuntimeReclaimSummary = {
  candidates: number;
  /** Recorded resources belonging to candidates, whether or not this run deleted them. */
  resources: number;
  reclaimed: number;
  retained: Record<RetentionReason, number>;
};

/** The reclamation API surface, named so a test can supply it without the whole account client. */
export type WorkspaceRuntimeReclaimApi = Pick<
  UserCloudflareAccountApi,
  | 'findD1DatabaseId'
  | 'workspaceDatabaseHoldsUserData'
  | 'deleteD1DatabaseById'
  | 'deleteManagedWorker'
  | 'deleteWorkspaceRuntimeContainer'
>;

export async function runUserWorkspaceRuntimeReclamation(
  env: Env,
  options: { now?: number; mode?: 'report' | 'enforce'; accountApi?: WorkspaceRuntimeReclaimApi } = {},
): Promise<WorkspaceRuntimeReclaimSummary> {
  const now = options.now ?? Date.now();
  const mode = options.mode ?? WORKSPACE_RUNTIME_RECLAIM_MODE;
  const summary: WorkspaceRuntimeReclaimSummary = {
    candidates: 0,
    resources: 0,
    reclaimed: 0,
    retained: { unrecorded: 0, holds_user_data: 0, unreadable: 0 },
  };

  const candidates = await env.DB.prepare(
    // A runtime that reached `ready` is never a candidate, and a provisioning claim that has not
    // expired is still someone's attempt in flight. `updated_at` is the last time anything moved.
    `SELECT runtimes.user_id AS user_id, connections.account_id AS account_id,
            connections.credential_handle AS credential_handle, runtimes.status AS status,
            runtimes.updated_at AS updated_at
       FROM user_computer_runtimes AS runtimes
       JOIN cloudflare_connections AS connections ON connections.user_id = runtimes.user_id
      WHERE connections.status = 'active' AND connections.credential_handle IS NOT NULL
        AND runtimes.status <> 'ready'
        AND runtimes.updated_at <= ?
        AND (runtimes.status = 'error' OR COALESCE(runtimes.provisioning_lease_expires_at, 0) <= ?)
      ORDER BY runtimes.updated_at
      LIMIT ?`,
  )
    .bind(now - WORKSPACE_RUNTIME_ABANDONED_MS, now, RECLAIM_USER_LIMIT)
    .all<AbandonedRuntimeRow>();

  for (const candidate of candidates.results) {
    summary.candidates += 1;
    await reclaimCandidate(env, candidate, now, mode, summary, options.accountApi);
  }

  if (summary.candidates > 0) {
    // The diff an operator has to read before enforcement can be turned on.
    logger.warn(
      `Workspace runtime reclamation in ${mode} mode: ${summary.candidates} abandoned runtime(s) holding ` +
        `${summary.resources} recorded resource(s), ${summary.reclaimed} reclaimed, retained ` +
        `${summary.retained.unrecorded} unrecorded, ${summary.retained.holds_user_data} still holding a workspace, ` +
        `${summary.retained.unreadable} unreadable`,
    );
  }
  return summary;
}

async function reclaimCandidate(
  env: Env,
  candidate: AbandonedRuntimeRow,
  now: number,
  mode: 'report' | 'enforce',
  summary: WorkspaceRuntimeReclaimSummary,
  suppliedApi: WorkspaceRuntimeReclaimApi | undefined,
): Promise<void> {
  const recorded = await listOutstandingUserWorkspaceRuntimeResources(env.DB, candidate.user_id, candidate.account_id);
  if (recorded.length === 0) {
    // The runtime predates the record, so what it created cannot be named. Saying so is the only
    // honest option: deriving the names from the account would be the prefix match this avoids.
    summary.retained.unrecorded += 1;
    logger.warn(`Abandoned workspace runtime for user ${candidate.user_id} has no recorded resources to reclaim`);
    return;
  }
  summary.resources += recorded.length;

  try {
    const api = suppliedApi ?? (await connectedAccountApi(env, candidate));
    const databases = await resolveDatabases(api, recorded);
    for (const database of databases) {
      if (database.id !== null && (await api.workspaceDatabaseHoldsUserData(database.id))) {
        // A workspace with chats in it is not an abandoned provisioning, whatever the runtime row
        // says. Nothing for this candidate is touched, including its Worker.
        summary.retained.holds_user_data += 1;
        logger.warn(`Abandoned workspace runtime for user ${candidate.user_id} still holds a workspace; left alone`);
        return;
      }
    }
    if (mode === 'report') {
      return;
    }

    // The container application first, while the Worker it is attached to still exists to name
    // it; then the Worker, so nothing is serving; then the database it was serving from.
    for (const resource of recorded.filter((entry) => entry.resourceType === 'container')) {
      await api.deleteWorkspaceRuntimeContainer(resource.resourceName);
    }
    for (const resource of recorded.filter((entry) => entry.resourceType === 'worker')) {
      await api.deleteManagedWorker(resource.resourceName);
    }
    for (const database of databases) {
      if (database.id !== null) {
        await api.deleteD1DatabaseById(database.id);
      }
    }
    await markUserWorkspaceRuntimeResourcesReclaimed({
      db: env.DB,
      userId: candidate.user_id,
      accountId: candidate.account_id,
      resources: recorded,
      now,
    });
    // The locator is the last thing to go, so a run interrupted anywhere above leaves a candidate
    // the next run picks up again rather than a runtime row pointing at nothing. It is deleted
    // only if nothing has touched it since the candidate was read: a provisioning attempt that
    // arrived after thirty days of silence is a fact worth saying out loud rather than erasing.
    const released = await env.DB.prepare(
      'DELETE FROM user_computer_runtimes WHERE user_id = ? AND status = ? AND updated_at = ?',
    )
      .bind(candidate.user_id, candidate.status, candidate.updated_at)
      .run();
    if (released.meta.changes === 0) {
      logger.warn(`The workspace runtime for user ${candidate.user_id} changed while it was being reclaimed`);
    }
    summary.reclaimed += recorded.length;
  } catch {
    // The account is named so an operator can go and look; the reason never carries a credential.
    summary.retained.unreadable += 1;
    logger.warn(`Unable to reclaim the abandoned workspace runtime for user ${candidate.user_id}`);
  }
}

/**
 * Pair every recorded database with the id it has to be deleted by. A record written before the
 * create call has no id yet, so the name is resolved once here; a name the account does not know
 * resolves to null, which means the database was never created or is already gone.
 */
async function resolveDatabases(
  api: WorkspaceRuntimeReclaimApi,
  recorded: readonly UserWorkspaceRuntimeResource[],
): Promise<{ name: string; id: string | null }[]> {
  const databases = recorded.filter((resource) => resource.resourceType === 'd1');
  return Promise.all(
    databases.map(async (resource) => ({
      name: resource.resourceName,
      id: resource.providerResourceId ?? (await api.findD1DatabaseId(resource.resourceName)),
    })),
  );
}

async function connectedAccountApi(env: Env, candidate: AbandonedRuntimeRow): Promise<UserCloudflareAccountApi> {
  const accessToken = await D1CloudflareCredentialVault.fromEnv(env).resolve(candidate.credential_handle);
  return new UserCloudflareAccountApi(candidate.account_id, accessToken);
}
