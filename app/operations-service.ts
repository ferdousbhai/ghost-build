import { WorkerEntrypoint } from 'cloudflare:workers';
import { USER_WORKSPACE_RUNTIME_SHA256 } from '~/generated/user-workspace-runtime.generated';
import { findCloudflareConnectionForUser } from '~/lib/.server/cloudflare/cloudflare-connection-repository';
import { provisionUserWorkspaceRuntime } from '~/lib/.server/cloudflare/user-workspace-runtime-provisioner';
import type { UserWorkspaceRuntimeStatus } from '~/lib/.server/cloudflare/user-workspace-runtime-repository';

// Restated as `ReconcileRuntimeResult` in the ghost-build-ops repository
// (`src/control-plane.ts`), which cannot import across the binding.
type ReconcileRuntimeResult =
  | { ok: true; status: UserWorkspaceRuntimeStatus; runtimeVersion: string }
  | { ok: false; reason: 'invalid-user' | 'connection-not-found' | 'provisioning-failed' };

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
}
