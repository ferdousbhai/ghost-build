import { USER_WORKSPACE_RUNTIME_GC_CRON } from '../../app/lib/.server/cloudflare/user-workspace-runtime-policy';
import { sweepAgentGcCandidatesBestEffort } from '../../app/lib/cloudflare/data/agent-gc.server';
import { sweepAppResourceGcCandidatesBestEffort } from '../../app/lib/cloudflare/data/app-resource-gc.server';
import { reconcileAppResourcesBestEffort } from '../../app/lib/cloudflare/data/app-resource-reconcile.server';

type RuntimeMaintenanceEnv = Parameters<typeof sweepAppResourceGcCandidatesBestEffort>[0]
  & Parameters<typeof reconcileAppResourcesBestEffort>[0]
  & Pick<Env, 'BuilderAgent'>;

/** Register the sole user-runtime maintenance job only for its provisioned trigger. */
export function scheduleUserWorkspaceRuntimeMaintenance(
  controller: Pick<ScheduledController, 'cron'>,
  env: RuntimeMaintenanceEnv,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
): boolean {
  if (controller.cron !== USER_WORKSPACE_RUNTIME_GC_CRON) {
    return false;
  }
  ctx.waitUntil(sweepAgentGcCandidatesBestEffort(env));
  ctx.waitUntil(sweepAppResourceGcCandidatesBestEffort(env));
  // Registry-blind backstop: reclaims resources the chat-anchored sweep can no longer see.
  ctx.waitUntil(reconcileAppResourcesBestEffort(env));
  return true;
}
