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
  test('creates only the D1 name fixed by the approved plan in the connected account', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ success: true, result: { uuid: 'd1-id', name: 'ghostbuild-deployment-1' } }),
      )
      .mockResolvedValueOnce(Response.json({ success: true, result: { subdomain: 'user-subdomain' } }));
    const authorizeRequest = vi.fn(async () => undefined);
    const api = new UserCloudflareAccountApi('account-1', 'user-token', request, authorizeRequest);

    await expect(api.createD1ForPlan(plan)).resolves.toEqual({ id: 'd1-id', name: 'ghostbuild-deployment-1' });
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
    expect(request.mock.contexts).toEqual([undefined, undefined]);
    expect(authorizeRequest).toHaveBeenCalledTimes(2);
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
      new UserCloudflareAccountApi('account-1', 'token', request).ensureR2ForPlan({ ...plan, resources: [] }),
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

  test('accepts a bucket concurrently created after its create request loses the race', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ success: false }, { status: 404 }))
      .mockResolvedValueOnce(
        Response.json({ success: false, errors: [{ message: 'bucket already exists' }] }, { status: 409 }),
      )
      .mockResolvedValueOnce(Response.json({ success: true, result: { name: 'ghostbuild-user-data' } }));
    const api = new UserCloudflareAccountApi('account-1', 'token', request);

    await expect(api.ensureR2Bucket('ghostbuild-user-data')).resolves.toEqual({
      id: 'ghostbuild-user-data',
      name: 'ghostbuild-user-data',
    });
    expect(request).toHaveBeenCalledTimes(3);
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

  test('deploys only the runtime data and backup bindings into the user account', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ success: true, result: { version_id: 'version-1' } }))
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: [
            {
              id: '0123456789abcdef0123456789abcdef',
              class: 'WorkspaceSandbox',
              script: 'ghostbuild-workspace-user',
              use_sqlite: true,
            },
          ],
        }),
      );
    const api = new UserCloudflareAccountApi('user-account', 'user-token', request);

    await expect(
      api.deployWorkspaceRuntimeWorker({
        workerName: 'ghostbuild-workspace-user',
        source: 'export default { fetch() { return new Response() } }',
        bucketName: 'ghostbuild-workspaces-user',
        controlPlaneSecret: 'control-plane-secret-that-is-long-enough',
        r2AccessKeyId: 'user-r2-access-key',
        r2SecretAccessKey: 'user-r2-secret-access-key-that-is-long-enough',
        runtimeVersion: 'a'.repeat(64),
        databaseId: '0123456789abcdef0123456789abcdef',
        apiToken: 'user-token',
        userId: 'user-1',
        connectionId: 'connection-1',
        connectionGeneration: 1,
        endpoint: 'https://ghostbuild-workspace-user.example.workers.dev',
      }),
    ).resolves.toEqual({
      workerVersionId: 'version-1',
      namespaceId: '0123456789abcdef0123456789abcdef',
    });

    const [scriptUrl, scriptInit] = request.mock.calls[0];
    expect(scriptUrl).toBe(
      'https://api.cloudflare.com/client/v4/accounts/user-account/workers/scripts/ghostbuild-workspace-user',
    );
    expect(scriptInit).toMatchObject({ method: 'PUT', headers: { authorization: 'Bearer user-token' } });
    const form = scriptInit?.body as FormData;
    const metadataPart = form.get('metadata');
    expect(metadataPart).toBeInstanceOf(Blob);
    const metadata = JSON.parse(await (metadataPart as Blob).text()) as {
      bindings: Array<Record<string, string>>;
      containers: Array<{ class_name: string }>;
      exports: Record<string, unknown>;
    };
    expect(metadata.containers).toEqual([{ class_name: 'WorkspaceSandbox' }]);
    expect(metadata.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'r2_bucket',
          name: 'BACKUP_BUCKET',
          bucket_name: 'ghostbuild-workspaces-user',
        }),
        expect.objectContaining({ type: 'secret_text', name: 'R2_ACCESS_KEY_ID', text: 'user-r2-access-key' }),
        expect.objectContaining({
          type: 'secret_text',
          name: 'R2_SECRET_ACCESS_KEY',
          text: 'user-r2-secret-access-key-that-is-long-enough',
        }),
      ]),
    );
    expect(metadata.bindings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'r2_bucket', name: 'APP_STORAGE' })]),
    );
    expect(metadata.exports).toHaveProperty('WorkspaceSandbox');
  });

  test('creates the Sandbox container application in the user account', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(
        Response.json({
          id: 'container-application-1',
          name: 'ghostbuild-workspace-user',
          durable_objects: { namespace_id: '0123456789abcdef0123456789abcdef' },
        }),
      );
    const api = new UserCloudflareAccountApi('user-account', 'user-token', request);
    const image = `docker.io/cloudflare/sandbox:0.12.4@sha256:${'b'.repeat(64)}`;

    await expect(
      api.ensureWorkspaceRuntimeContainer({
        applicationName: 'ghostbuild-workspace-user',
        namespaceId: '0123456789abcdef0123456789abcdef',
        image,
      }),
    ).resolves.toEqual({ id: 'container-application-1', name: 'ghostbuild-workspace-user' });

    expect(request).toHaveBeenNthCalledWith(
      1,
      'https://api.cloudflare.com/client/v4/accounts/user-account/containers/applications',
      expect.objectContaining({ method: 'GET' }),
    );
    const [, createInit] = request.mock.calls[1];
    expect(JSON.parse(String(createInit?.body))).toMatchObject({
      name: 'ghostbuild-workspace-user',
      configuration: { image, instance_type: 'basic' },
      durable_objects: { namespace_id: '0123456789abcdef0123456789abcdef' },
    });
  });
});
