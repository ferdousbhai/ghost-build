import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { getToolInvocation } from 'ghostbuild-agent/ai-compat';
import { deploymentApprovalMarker, parsePendingDeploymentApproval } from '~/lib/deployment-approval';

export function latestPendingDeploymentPlanMarker(messages: GhostbuildMessage[]): string | null {
  const latest = messages.at(-1);
  if (latest?.role !== 'assistant') {
    return null;
  }
  for (const part of latest.parts) {
    const invocation = getToolInvocation(part);
    if (invocation?.toolName === 'deploy' && invocation.state === 'result') {
      const deployment = parsePendingDeploymentApproval(invocation.result);
      if (deployment) {
        return deploymentApprovalMarker(deployment);
      }
    }
  }
  return null;
}
