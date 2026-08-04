import type { GhostbuildMessage, PendingDeploymentApproval } from 'ghostbuild-agent/ai-compat';
import { getToolInvocation } from 'ghostbuild-agent/ai-compat';
import { parsePendingDeploymentApproval } from '~/lib/deployment-approval';

export function latestPendingDeploymentPlan(messages: GhostbuildMessage[]): PendingDeploymentApproval | null {
  const latest = messages.at(-1);
  if (latest?.role !== 'assistant') {
    return null;
  }
  for (const part of latest.parts) {
    const invocation = getToolInvocation(part);
    if (invocation?.toolName === 'deploy' && invocation.state === 'output-available') {
      const deployment = parsePendingDeploymentApproval(invocation.output);
      if (deployment) {
        return deployment;
      }
    }
  }
  return null;
}
