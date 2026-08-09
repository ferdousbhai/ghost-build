import { isGhostbuildToolResult } from 'ghostbuild-agent/tool-result';
import type { PendingDeploymentApproval } from 'ghostbuild-agent/ai-compat';

export type { PendingDeploymentApproval } from 'ghostbuild-agent/ai-compat';

export function parsePendingDeploymentApproval(result: unknown): PendingDeploymentApproval | null {
  if (isGhostbuildToolResult(result) && result.ok && isRecord(result.data)) {
    if (result.data.state === 'awaiting-approval') {
      return parsePendingDeploymentApprovalData(result.data.deployment);
    }
    return null;
  }
  return null;
}

export function parsePendingDeploymentApprovalData(value: unknown): PendingDeploymentApproval | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !/^[a-f0-9]{64}$/.test(String(value.planDigest))) {
    return null;
  }
  if (!Array.isArray(value.resources) || !value.resources.every(isResource)) {
    return null;
  }
  return {
    id: value.id,
    planDigest: String(value.planDigest),
    resources: value.resources,
  };
}

function isResource(value: unknown): value is PendingDeploymentApproval['resources'][number] {
  return (
    isRecord(value) &&
    typeof value.type === 'string' &&
    typeof value.logicalName === 'string' &&
    typeof value.proposedName === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
