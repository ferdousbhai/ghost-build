import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { getToolInvocation } from 'ghostbuild-agent/ai-compat';
import { DEPLOYMENT_PLAN_MARKER } from '~/lib/deployment-plan-marker';

export function latestMessageHasPendingDeploymentPlan(messages: GhostbuildMessage[]): boolean {
  const latest = messages.at(-1);
  if (latest?.role !== 'assistant') {
    return false;
  }
  return latest.parts.some((part) => {
    const invocation = getToolInvocation(part);
    return (
      invocation?.toolName === 'deploy' &&
      invocation.state === 'result' &&
      typeof invocation.result === 'string' &&
      invocation.result.includes(DEPLOYMENT_PLAN_MARKER)
    );
  });
}
