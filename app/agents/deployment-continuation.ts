import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { getToolInvocation } from 'ghostbuild-agent/ai-compat';
import { DEPLOYMENT_PLAN_MARKER } from '~/lib/deployment-plan-marker';

export function latestMessageHasPendingDeploymentPlan(messages: GhostbuildMessage[]): boolean {
  return latestPendingDeploymentPlanMarker(messages) !== null;
}

export function latestPendingDeploymentPlanMarker(messages: GhostbuildMessage[]): string | null {
  const latest = messages.at(-1);
  if (latest?.role !== 'assistant') {
    return null;
  }
  for (const part of latest.parts) {
    const invocation = getToolInvocation(part);
    if (
      invocation?.toolName === 'deploy' &&
      invocation.state === 'result' &&
      typeof invocation.result === 'string' &&
      invocation.result.includes(DEPLOYMENT_PLAN_MARKER)
    ) {
      return invocation.result.split('\n').find((line) => line.startsWith(DEPLOYMENT_PLAN_MARKER)) ?? null;
    }
  }
  return null;
}
