import { isGhostbuildToolResult } from 'ghostbuild-agent/tool-result';

export const DEPLOYMENT_PLAN_MARKER = 'GHOSTBUILD_DEPLOYMENT_PLAN:';

export type PendingDeploymentApproval = {
  id: string;
  planDigest: string;
  resources: Array<{ type: string; logicalName: string; proposedName: string }>;
};

export function parsePendingDeploymentApproval(result: unknown): PendingDeploymentApproval | null {
  if (isGhostbuildToolResult(result) && result.ok && isRecord(result.data)) {
    if (result.data.state === 'awaiting-approval') {
      return parseDeployment(result.data.deployment);
    }
    return null;
  }
  if (typeof result !== 'string') {
    return null;
  }
  const markerLine = result.split('\n').find((line) => line.startsWith(DEPLOYMENT_PLAN_MARKER));
  if (!markerLine) {
    return null;
  }
  try {
    return parseDeployment(JSON.parse(markerLine.slice(DEPLOYMENT_PLAN_MARKER.length)));
  } catch {
    return null;
  }
}

export function deploymentApprovalMarker(deployment: PendingDeploymentApproval): string {
  return `${DEPLOYMENT_PLAN_MARKER}${JSON.stringify(deployment)}`;
}

export function stripPendingDeploymentApprovalMarker(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.startsWith(DEPLOYMENT_PLAN_MARKER))
    .join('\n')
    .trim();
}

function parseDeployment(value: unknown): PendingDeploymentApproval | null {
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
