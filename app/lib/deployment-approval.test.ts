import { describe, expect, it } from 'vitest';
import { parsePendingDeploymentApproval, parsePendingDeploymentApprovalData } from './deployment-approval';

describe('parsePendingDeploymentApproval', () => {
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

  it('rejects prose, failures, and incomplete structured data', () => {
    expect(parsePendingDeploymentApproval('GHOSTBUILD_DEPLOYMENT_PLAN:{"id":"deployment-1"}')).toBeNull();
    expect(parsePendingDeploymentApproval({ version: 1, ok: false, summary: 'failed' })).toBeNull();
    expect(
      parsePendingDeploymentApproval({
        version: 1,
        ok: true,
        summary: 'ready',
        data: { state: 'awaiting-approval', deployment: { id: 'deployment-1' } },
      }),
    ).toBeNull();
  });

  it('validates deployment data received from the chat stream', () => {
    expect(
      parsePendingDeploymentApprovalData({
        id: 'deployment-3',
        planDigest: 'd'.repeat(64),
        resources: [{ type: 'worker', logicalName: 'app', proposedName: 'focus-timer' }],
      }),
    ).toMatchObject({ id: 'deployment-3', planDigest: 'd'.repeat(64) });
    expect(parsePendingDeploymentApprovalData({ id: 'deployment-3', planDigest: 'invalid', resources: [] })).toBeNull();
  });
});
