import { describe, expect, it } from 'vitest';
import {
  DEPLOYMENT_PLAN_MARKER,
  parsePendingDeploymentApproval,
  stripPendingDeploymentApprovalMarker,
} from './deployment-approval';

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

  it('extracts a structured deployment result', () => {
    const result = parsePendingDeploymentApproval({
      version: 1,
      ok: true,
      summary: 'ready',
      data: {
        state: 'awaiting-approval',
        revision: 'b'.repeat(64),
        deployment: {
          id: 'deployment-2',
          planDigest: 'c'.repeat(64),
          resources: [{ type: 'worker', logicalName: 'app', proposedName: 'ghostbuild-app' }],
        },
      },
    });
    expect(result).toMatchObject({ id: 'deployment-2', planDigest: 'c'.repeat(64) });
  });

  it('removes the machine marker from assistant-visible text', () => {
    const text = `Review and approve below.\n\n${DEPLOYMENT_PLAN_MARKER}{"id":"deployment-1"}`;
    expect(stripPendingDeploymentApprovalMarker(text)).toBe('Review and approve below.');
  });
});
