import { describe, expect, it } from 'vitest';
import { buildDeploymentPlan } from './deployment-plan';

describe('buildDeploymentPlan', () => {
  it('binds the user-account billing policy and source digest into an immutable plan', async () => {
    const result = await buildDeploymentPlan({
      deploymentId: 'deployment-1',
      snapshot: new Blob(['source']),
    });

    expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.plan.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.plan.billing).toEqual({
      infrastructure: 'user_cloudflare_account',
      workersAi: 'user_cloudflare_account',
      workersPaidUpgrade: 'explicit_user_authorization_required',
    });
    expect(result.plan.resources.map(({ type }) => type)).toEqual([
      'worker',
      'd1',
      'r2',
      'durable_object',
      'workers_ai',
    ]);
  });

  it('changes the approval digest when the source changes', async () => {
    const first = await buildDeploymentPlan({ deploymentId: 'deployment-1', snapshot: new Blob(['one']) });
    const second = await buildDeploymentPlan({ deploymentId: 'deployment-1', snapshot: new Blob(['two']) });
    expect(first.digest).not.toBe(second.digest);
  });
});
