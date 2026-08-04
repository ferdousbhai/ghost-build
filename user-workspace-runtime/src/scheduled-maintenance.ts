import { USER_WORKSPACE_RUNTIME_GC_CRON } from '../../app/lib/.server/cloudflare/user-workspace-runtime-policy';
import { sweepAgentGcCandidatesBestEffort } from '../../app/lib/cloudflare/data/agent-gc.server';

type RuntimeMaintenanceEnv = Pick<Env, 'BuilderAgent' | 'DB'>;

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
  return true;
}
