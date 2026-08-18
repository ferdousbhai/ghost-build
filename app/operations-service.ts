import { WorkerEntrypoint } from 'cloudflare:workers';
import { USER_WORKSPACE_RUNTIME_SHA256 } from '~/generated/user-workspace-runtime.generated';
import { D1CloudflareCredentialVault } from '~/lib/.server/cloudflare/cloudflare-credential-vault';
import { findCloudflareConnectionForUser } from '~/lib/.server/cloudflare/cloudflare-connection-repository';
import { UserCloudflareAccountApi } from '~/lib/.server/cloudflare/user-account-api';
import { provisionUserWorkspaceRuntime } from '~/lib/.server/cloudflare/user-workspace-runtime-provisioner';
import type { UserWorkspaceRuntimeStatus } from '~/lib/.server/cloudflare/user-workspace-runtime-repository';
import {
  APP_RESOURCE_RECONCILE_MODE,
  reconcileAppResources as sweepAccountAppResources,
  type AppResourceReconcileMode,
  type OrphanedAppResourceKind,
} from '~/lib/cloudflare/data/app-resource-reconcile.server';

// Restated as `ReconcileRuntimeResult` in the ghost-build-ops repository
// (`src/control-plane.ts`), which cannot import across the binding.
type ReconcileRuntimeResult =
  | { ok: true; status: UserWorkspaceRuntimeStatus; runtimeVersion: string }
  | { ok: false; reason: 'invalid-user' | 'connection-not-found' | 'provisioning-failed' };

// Restated as `ReconcileAppResourcesResult` in the ghost-build-ops repository.
type ReconcileAppResourcesResult =
  | {
      ok: true;
      mode: AppResourceReconcileMode;
      scanned: number;
      orphans: { kind: OrphanedAppResourceKind; name: string }[];
      deleted: { kind: OrphanedAppResourceKind; name: string }[];
    }
  | { ok: false; reason: 'invalid-user' | 'connection-not-found' | 'reconcile-failed' };

/**
 * Private control-plane surface for the `ghostbuild-ops` Worker.
 *
 * These are RPC methods rather than routes: HTTP only ever dispatches to
 * `fetch()`, so an entrypoint carries no public attack surface even though this
 * Worker serves ghostbuild.dev. Reachability *is* the authorization — only a
 * Worker holding a Service binding to this entrypoint can call it — which is
 * why no shared secret is involved.
 */
export class OperationsService extends WorkerEntrypoint<Env> {
  async runtimeVersion(): Promise<string> {
    return USER_WORKSPACE_RUNTIME_SHA256;
  }

  async reconcileRuntime(userId: string): Promise<ReconcileRuntimeResult> {
    if (typeof userId !== 'string' || userId.length === 0 || userId.length > 128) {
      return { ok: false, reason: 'invalid-user' };
    }
    const connection = await findCloudflareConnectionForUser(this.env.DB, userId);
    if (!connection || connection.status !== 'active') {
      return { ok: false, reason: 'connection-not-found' };
    }
    try {
      const runtime = await provisionUserWorkspaceRuntime({
        env: this.env,
        userId,
        connectionId: connection.id,
      });
      return { ok: true, status: runtime.status, runtimeVersion: runtime.runtimeVersion };
    } catch {
      console.error('Operations workspace runtime reconciliation failed');
      return { ok: false, reason: 'provisioning-failed' };
    }
  }

  /**
   * Sweep one user's Cloudflare account for app resources no live Worker anchors.
   *
   * This runs here rather than in the user's workspace runtime for two reasons: a collector
   * hosted inside the thing being collected cannot survive that thing's deletion, and its logs
   * would land in the user's own account where no operator can read the diff. The credentials
   * stay here too - the caller gets a report, never a token.
   */
  async reconcileAppResources(userId: string): Promise<ReconcileAppResourcesResult> {
    if (typeof userId !== 'string' || userId.length === 0 || userId.length > 128) {
      return { ok: false, reason: 'invalid-user' };
    }
    const connection = await findCloudflareConnectionForUser(this.env.DB, userId);
    if (!connection || connection.status !== 'active' || !connection.credentialHandle) {
      return { ok: false, reason: 'connection-not-found' };
    }
    try {
      const accessToken = await D1CloudflareCredentialVault.fromEnv(this.env).resolve(connection.credentialHandle);
      const report = await sweepAccountAppResources(new UserCloudflareAccountApi(connection.accountId, accessToken), {
        mode: APP_RESOURCE_RECONCILE_MODE,
      });
      return {
        ok: true,
        mode: APP_RESOURCE_RECONCILE_MODE,
        scanned: report.scanned,
        orphans: report.orphans.map(({ kind, name }) => ({ kind, name })),
        deleted: report.deleted.map(({ kind, name }) => ({ kind, name })),
      };
    } catch {
      console.error('Operations app resource reconciliation failed');
      return { ok: false, reason: 'reconcile-failed' };
    }
  }
}
