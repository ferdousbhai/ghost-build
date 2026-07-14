import { describe, expect, test, vi } from 'vitest';
import type { DeploymentPlan } from './deployment-plan';
import { CloudflareAccountApiError, UserCloudflareAccountApi } from './user-account-api';

const plan: DeploymentPlan = {
  version: 1,
  deploymentId: 'deployment-1',
  sourceSha256: 'a'.repeat(64),
  billing: {
    infrastructure: 'user_cloudflare_account',
    workersAi: 'user_cloudflare_account',
    workersPaidUpgrade: 'explicit_user_authorization_required',
  },
  resources: [
    { type: 'd1', logicalName: 'DB', proposedName: 'ghostbuild-deployment-1' },
    { type: 'r2', logicalName: 'APP_STORAGE', proposedName: 'ghostbuild-deployment-1-storage' },
  ],
};

describe('UserCloudflareAccountApi', () => {
  test('creates only the D1 and R2 names fixed by the approved plan in the connected account', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ success: true, result: { uuid: 'd1-id', name: 'ghostbuild-deployment-1' } }),
      )
      .mockResolvedValueOnce(Response.json({ success: true, result: { name: 'ghostbuild-deployment-1-storage' } }))
      .mockResolvedValueOnce(Response.json({ success: true, result: { subdomain: 'user-subdomain' } }));
    const api = new UserCloudflareAccountApi('account-1', 'user-token', request);

    await expect(api.createD1ForPlan(plan)).resolves.toEqual({ id: 'd1-id', name: 'ghostbuild-deployment-1' });
    await expect(api.createR2ForPlan(plan)).resolves.toEqual({
      id: 'ghostbuild-deployment-1-storage',
      name: 'ghostbuild-deployment-1-storage',
    });
    await expect(api.getWorkersSubdomain()).resolves.toBe('user-subdomain');

    expect(request).toHaveBeenNthCalledWith(
      1,
      'https://api.cloudflare.com/client/v4/accounts/account-1/d1/database',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'ghostbuild-deployment-1' }),
        headers: expect.objectContaining({ authorization: 'Bearer user-token' }),
      }),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      'https://api.cloudflare.com/client/v4/accounts/account-1/r2/buckets',
      expect.objectContaining({ body: JSON.stringify({ name: 'ghostbuild-deployment-1-storage' }) }),
    );
    expect(request.mock.contexts).toEqual([undefined, undefined, undefined]);
  });

  test('fails closed when Cloudflare returns a different resource or the plan is malformed', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ success: true, result: { uuid: 'd1-id', name: 'some-other-database' } }));
    await expect(
      new UserCloudflareAccountApi('account-1', 'token', request).createD1ForPlan(plan),
    ).rejects.toBeInstanceOf(CloudflareAccountApiError);
    await expect(
      new UserCloudflareAccountApi('account-1', 'token', request).createR2ForPlan({ ...plan, resources: [] }),
    ).rejects.toBeInstanceOf(CloudflareAccountApiError);
  });

  test('does not leak the connected token through provider errors', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ success: false, errors: [{ message: 'permission denied' }] }, { status: 403 }),
      );
    await expect(
      new UserCloudflareAccountApi('account-1', 'secret-token', request).createD1ForPlan(plan),
    ).rejects.toThrow('permission denied');
  });
});
