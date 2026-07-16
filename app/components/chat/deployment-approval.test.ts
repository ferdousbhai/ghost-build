import { describe, expect, it } from 'vitest';
import { DEPLOYMENT_PLAN_MARKER } from '~/lib/deployment-plan-marker';
import { parsePendingDeploymentApproval, stripPendingDeploymentApprovalMarker } from './deployment-approval';

describe('parsePendingDeploymentApproval', () => {
  it('extracts a server-issued deployment plan marker', () => {
    const result = parsePendingDeploymentApproval(
      `Ready\n${DEPLOYMENT_PLAN_MARKER}${JSON.stringify({
        id: 'deployment-1',
        planDigest: 'a'.repeat(64),
        resources: [{ type: 'worker', logicalName: 'app', proposedName: 'ghostbuild-app' }],
      })}\n`,
    );
    expect(result).toMatchObject({ id: 'deployment-1', planDigest: 'a'.repeat(64) });
  });

  it('rejects malformed or incomplete markers', () => {
    expect(parsePendingDeploymentApproval(`${DEPLOYMENT_PLAN_MARKER}{bad`)).toBeNull();
    expect(
      parsePendingDeploymentApproval(`${DEPLOYMENT_PLAN_MARKER}${JSON.stringify({ id: 'deployment-1' })}`),
    ).toBeNull();
  });

  it('removes the machine marker from assistant-visible text', () => {
    const text = `Review and approve below.\n\n${DEPLOYMENT_PLAN_MARKER}{"id":"deployment-1"}`;
    expect(stripPendingDeploymentApprovalMarker(text)).toBe('Review and approve below.');
  });
});
