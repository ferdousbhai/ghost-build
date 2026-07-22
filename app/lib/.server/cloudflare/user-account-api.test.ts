import { describe, expect, test, vi } from 'vitest';
import type { DeploymentPlan } from './deployment-plan';
import { CloudflareAccountApiError, UserCloudflareAccountApi } from './user-account-api';
import {
  APP_AGENT_SECURITY_BOUNDARY_SHA256,
  DEPLOYMENT_SECURITY_BASELINE_VERSION,
  TEMPLATE_SOURCE_SHA256,
} from './deployment-security-baseline';

const plan: DeploymentPlan = {
  version: 2,
  deploymentId: 'deployment-1',
  sourceSha256: 'a'.repeat(64),
  templateSourceSha256: TEMPLATE_SOURCE_SHA256,
  securityBaselineVersion: DEPLOYMENT_SECURITY_BASELINE_VERSION,
  securityBoundarySha256: APP_AGENT_SECURITY_BOUNDARY_SHA256,
  billing: {
    infrastructure: 'user_cloudflare_account',
    workersAi: 'user_cloudflare_account',
    workersPaidUpgrade: 'explicit_user_authorization_required',
  },
  resources: [
    { type: 'd1', logicalName: 'DB', proposedName: 'ghostbuild-deployment-1' },
    {
      type: 'd1',
      logicalName: 'AGENT_SECURITY_DB',
      proposedName: 'ghostbuild-deployment-1-agent-security',
    },
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
    const authorizeRequest = vi.fn(async () => undefined);
    const api = new UserCloudflareAccountApi('account-1', 'user-token', request, authorizeRequest);

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
        signal: expect.any(AbortSignal),
        headers: expect.objectContaining({ authorization: 'Bearer user-token' }),
      }),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      'https://api.cloudflare.com/client/v4/accounts/account-1/r2/buckets',
      expect.objectContaining({ body: JSON.stringify({ name: 'ghostbuild-deployment-1-storage' }) }),
    );
    expect(request.mock.contexts).toEqual([undefined, undefined, undefined]);
    expect(authorizeRequest).toHaveBeenCalledTimes(3);
    authorizeRequest.mock.invocationCallOrder.forEach((authorizationOrder, index) => {
      expect(authorizationOrder).toBeLessThan(request.mock.invocationCallOrder[index]);
    });
  });

  test('creates the protected D1 only under its independently approved plan name', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json({
        success: true,
        result: {
          uuid: 'agent-security-d1-id',
          name: 'ghostbuild-deployment-1-agent-security',
        },
      }),
    );

    await expect(
      new UserCloudflareAccountApi('account-1', 'token', request).createD1ForPlan(plan, 'AGENT_SECURITY_DB'),
    ).resolves.toEqual({
      id: 'agent-security-d1-id',
      name: 'ghostbuild-deployment-1-agent-security',
    });
    expect(request).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/account-1/d1/database',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'ghostbuild-deployment-1-agent-security' }),
      }),
    );
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

  test('reuses already provisioned plan resources after an interrupted deployment', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ success: true, result: [{ uuid: 'existing-d1', name: 'ghostbuild-deployment-1' }] }),
      )
      .mockResolvedValueOnce(Response.json({ success: true, result: { name: 'ghostbuild-deployment-1-storage' } }));
    const api = new UserCloudflareAccountApi('account-1', 'token', request);
    await expect(api.ensureD1ForPlan(plan)).resolves.toEqual({
      id: 'existing-d1',
      name: 'ghostbuild-deployment-1',
    });
    await expect(api.ensureR2ForPlan(plan)).resolves.toEqual({
      id: 'ghostbuild-deployment-1-storage',
      name: 'ghostbuild-deployment-1-storage',
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.every((call) => call[1]?.method === 'GET')).toBe(true);
  });

  test('revalidates authorization for the create request after an ensure lookup', async () => {
    let generation = 1;
    const authorizeRequest = vi.fn(async () => {
      if (generation !== 1) {
        throw new Error('Cloudflare connection is unavailable.');
      }
    });
    const request = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.method === 'GET') {
        generation = 2;
        return Response.json({ success: true, result: [] });
      }
      return Response.json({
        success: true,
        result: { uuid: 'd1-id', name: 'ghostbuild-deployment-1' },
      });
    });
    const api = new UserCloudflareAccountApi('account-1', 'token', request, authorizeRequest);

    await expect(api.ensureD1ForPlan(plan)).rejects.toThrow('Cloudflare connection is unavailable.');

    expect(authorizeRequest).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining('/d1/database?name='),
      expect.objectContaining({ method: 'GET' }),
    );
  });

  test('revalidates authorization for an R2 create after a not-found lookup', async () => {
    let generation = 1;
    const authorizeRequest = vi.fn(async () => {
      if (generation !== 1) {
        throw new Error('Cloudflare connection is unavailable.');
      }
    });
    const request = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.method === 'GET') {
        generation = 2;
        return Response.json({ success: false }, { status: 404 });
      }
      return Response.json({ success: true, result: { name: 'ghostbuild-deployment-1-storage' } });
    });
    const api = new UserCloudflareAccountApi('account-1', 'token', request, authorizeRequest);

    await expect(api.ensureR2ForPlan(plan)).rejects.toThrow('Cloudflare connection is unavailable.');

    expect(authorizeRequest).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining('/r2/buckets/ghostbuild-deployment-1-storage'),
      expect.objectContaining({ method: 'GET' }),
    );
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

  test('reads the exact active Worker version, its bindings, and cleanup schedules', async () => {
    const authorizeRequest = vi.fn(async () => undefined);
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: {
            deployments: [
              {
                id: 'provider-deployment-1',
                created_on: '2026-07-20T10:00:00Z',
                versions: [{ percentage: 100, version_id: 'worker-version-1' }],
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: {
            id: 'worker-version-1',
            resources: {
              bindings: [{ name: 'CF_VERSION_METADATA', type: 'version_metadata' }],
              script: { etag: 'etag-1' },
            },
          },
        }),
      )
      .mockResolvedValueOnce(Response.json({ success: true, result: { schedules: [{ cron: '0 3 * * *' }] } }));

    await expect(
      new UserCloudflareAccountApi('account-1', 'token', request, authorizeRequest).readActiveWorkerDeployment(
        'worker-name',
      ),
    ).resolves.toEqual({
      providerDeploymentId: 'provider-deployment-1',
      workerVersionId: 'worker-version-1',
      scriptEtag: 'etag-1',
      bindings: [{ name: 'CF_VERSION_METADATA', type: 'version_metadata' }],
      crons: ['0 3 * * *'],
    });
    expect(authorizeRequest).toHaveBeenCalledTimes(3);
    authorizeRequest.mock.invocationCallOrder.forEach((authorizationOrder, index) => {
      expect(authorizationOrder).toBeLessThan(request.mock.invocationCallOrder[index]);
    });
  });

  test('does not fall back to an older full deployment while the newest deployment is gradual', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json({
        success: true,
        result: {
          deployments: [
            {
              id: 'new-gradual',
              created_on: '2026-07-20T11:00:00Z',
              versions: [
                { percentage: 50, version_id: 'new-a' },
                { percentage: 50, version_id: 'new-b' },
              ],
            },
            {
              id: 'old-full',
              created_on: '2026-07-20T10:00:00Z',
              versions: [{ percentage: 100, version_id: 'old' }],
            },
          ],
        },
      }),
    );

    await expect(
      new UserCloudflareAccountApi('account-1', 'token', request).readActiveWorkerDeployment('worker-name'),
    ).rejects.toThrow('ambiguous active Worker deployment');
    expect(request).toHaveBeenCalledOnce();
  });
});
