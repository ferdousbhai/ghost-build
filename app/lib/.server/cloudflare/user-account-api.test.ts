import { describe, expect, test, vi } from 'vitest';
import type { DeploymentPlan } from './deployment-plan';
import { deploymentAssetHash, type DeploymentArtifactFile } from './deployment-artifact';
import { CloudflareAccountApiError, UserCloudflareAccountApi } from './user-account-api';
import {
  APP_AGENT_SECURITY_BOUNDARY_SHA256,
  DEPLOYMENT_SECURITY_BASELINE_VERSION,
  TEMPLATE_SOURCE_SHA256,
} from './deployment-security-baseline';
import { USER_WORKSPACE_RUNTIME_GC_CRON } from './user-workspace-runtime-policy';

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

async function artifactFile(path: string, contents: string): Promise<DeploymentArtifactFile> {
  const bytes = new TextEncoder().encode(contents);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return {
    path,
    bytes,
    size: bytes.byteLength,
    sha256: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
  };
}

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
        redirect: 'manual',
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

  test('fails closed instead of following a redirected Cloudflare API response', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 307,
        headers: { location: 'https://attacker.example/collect' },
      }),
    );

    await expect(
      new UserCloudflareAccountApi('account-1', 'user-token', request).createD1ForPlan(plan),
    ).rejects.toThrow('Cloudflare API request redirected unexpectedly.');
    expect(request).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/account-1/d1/database',
      expect.objectContaining({ redirect: 'manual' }),
    );
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

  test('rejects a matching D1 readback without an identity instead of creating a replacement', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ success: true, result: [{ name: 'ghostbuild-deployment-1' }] }));

    await expect(new UserCloudflareAccountApi('account-1', 'token', request).ensureD1ForPlan(plan)).rejects.toThrow(
      'invalid D1 resource',
    );
    expect(request).toHaveBeenCalledOnce();
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

  test('rejects malformed R2 readback instead of creating a replacement bucket', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ success: true, result: {} }));

    await expect(new UserCloudflareAccountApi('account-1', 'token', request).ensureR2ForPlan(plan)).rejects.toThrow(
      'invalid R2 resource',
    );
    expect(request).toHaveBeenCalledOnce();
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

  test('rejects a D1 response when any statement reports failure', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        success: true,
        result: [
          { success: true, results: [] },
          { success: false, results: [] },
        ],
      }),
    );

    await expect(
      new UserCloudflareAccountApi('account-1', 'token', request).executeD1(
        '0123456789abcdef0123456789abcdef',
        'CREATE TABLE first (id TEXT); CREATE TABLE second (id TEXT)',
      ),
    ).rejects.toThrow('unsuccessful D1 query result');
  });

  test.each([{}, [], [{ success: true, results: {} }]])('rejects malformed D1 query result %#', async (result) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ success: true, result }));

    await expect(
      new UserCloudflareAccountApi('account-1', 'token', request).executeD1(
        '0123456789abcdef0123456789abcdef',
        'SELECT 1',
      ),
    ).rejects.toThrow('unsuccessful D1 query result');
  });

  test('applies each migration and its marker in one transactional D1 batch', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ success: true, result: [{ success: true, results: [] }] }))
      .mockResolvedValueOnce(Response.json({ success: true, result: [{ success: true, results: [] }] }))
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: [
            { success: true, results: [] },
            { success: true, results: [] },
          ],
        }),
      );
    const api = new UserCloudflareAccountApi('account-1', 'token', request);

    await api.applyD1Migrations('0123456789abcdef0123456789abcdef', [
      { name: '0001_users.sql', sql: 'CREATE TABLE users (id TEXT PRIMARY KEY)' },
    ]);

    const batch = JSON.parse(String(request.mock.calls[2]?.[1]?.body)) as { batch: Array<{ sql: string }> };
    expect(batch.batch).toHaveLength(2);
    expect(batch.batch[0]?.sql).toBe('CREATE TABLE users (id TEXT PRIMARY KEY)');
    expect(batch.batch[1]?.sql).toContain('ghostbuild_runtime_migrations');
  });

  test('resolves an ambiguous D1 batch acknowledgement by reading the transactional marker', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ success: true, result: [{ success: true, results: [] }] }))
      .mockResolvedValueOnce(Response.json({ success: true, result: [{ success: true, results: [] }] }))
      .mockRejectedValueOnce(new Error('network acknowledgement lost'))
      .mockResolvedValueOnce(
        Response.json({ success: true, result: [{ success: true, results: [{ name: '0001_users.sql' }] }] }),
      );
    const api = new UserCloudflareAccountApi('account-1', 'token', request);

    await expect(
      api.applyD1Migrations('0123456789abcdef0123456789abcdef', [
        { name: '0001_users.sql', sql: 'ALTER TABLE users ADD COLUMN display_name TEXT' },
      ]),
    ).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(4);
  });

  test('replaces runtime schedules with exactly one deterministic GC trigger', async () => {
    const authorizeRequest = vi.fn(async () => undefined);
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json({
        success: true,
        result: {
          schedules: [
            {
              cron: USER_WORKSPACE_RUNTIME_GC_CRON,
              created_on: '2026-08-04T10:00:00Z',
              modified_on: '2026-08-04T10:00:00Z',
            },
          ],
        },
      }),
    );

    await expect(
      new UserCloudflareAccountApi('account-1', 'token', request, authorizeRequest).configureWorkspaceRuntimeGcSchedule(
        'ghostbuild-workspace-1',
      ),
    ).resolves.toBeUndefined();

    expect(request).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts/ghostbuild-workspace-1/schedules',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify([{ cron: '*/15 * * * *' }]),
        headers: expect.objectContaining({
          authorization: 'Bearer token',
          'content-type': 'application/json',
        }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(authorizeRequest).toHaveBeenCalledOnce();
  });

  test.each([
    ['missing schedule collection', {}],
    ['no schedule', { schedules: [] }],
    ['an additional schedule', { schedules: [{ cron: USER_WORKSPACE_RUNTIME_GC_CRON }, { cron: '0 0 * * *' }] }],
    ['a changed schedule', { schedules: [{ cron: '0 0 * * *' }] }],
    ['invalid schedule metadata', { schedules: [{ cron: USER_WORKSPACE_RUNTIME_GC_CRON, created_on: 1 }] }],
  ])('rejects schedule readback with %s', async (_label, result) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ success: true, result }));

    await expect(
      new UserCloudflareAccountApi('account-1', 'token', request).configureWorkspaceRuntimeGcSchedule(
        'ghostbuild-workspace-1',
      ),
    ).rejects.toThrow('invalid workspace runtime schedules');

    expect(request).toHaveBeenCalledOnce();
  });

  test('rejects an unsuccessful schedule update envelope', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        success: false,
        errors: [{ code: 1000, message: 'schedule update rejected' }],
        result: { schedules: [{ cron: USER_WORKSPACE_RUNTIME_GC_CRON }] },
      }),
    );

    await expect(
      new UserCloudflareAccountApi('account-1', 'token', request).configureWorkspaceRuntimeGcSchedule(
        'ghostbuild-workspace-1',
      ),
    ).rejects.toThrow('schedule update rejected');

    expect(request).toHaveBeenCalledOnce();
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
              script_runtime: { compatibility_date: '2026-07-21', compatibility_flags: ['nodejs_compat'] },
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
      compatibilityDate: '2026-07-21',
      compatibilityFlags: ['nodejs_compat'],
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

  test('rejects a malformed Worker deployment collection', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ success: true, result: {} }));

    await expect(
      new UserCloudflareAccountApi('account-1', 'token', request).readActiveWorkerDeployment('worker-name'),
    ).rejects.toThrow('invalid Worker deployments');
    expect(request).toHaveBeenCalledOnce();
  });

  test('uploads assets, creates an immutable version, and promotes only that UUID at 100 percent', async () => {
    const module = await artifactFile('index.js', 'export default { fetch() { return new Response("ok") } }');
    const asset = await artifactFile('index.html', '<h1>Ghostbuild</h1>');
    const duplicateAsset = await artifactFile('nested/index.html', '<h1>Ghostbuild</h1>');
    const assetHash = await deploymentAssetHash(asset);
    const workerVersionId = '11111111-1111-4111-8111-111111111111';
    const providerDeploymentId = '22222222-2222-4222-8222-222222222222';
    const versions = [{ percentage: 100, version_id: workerVersionId }];
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ success: true, result: { jwt: 'asset-session-jwt', buckets: [[assetHash]] } }),
      )
      .mockResolvedValueOnce(Response.json({ success: true, result: { jwt: 'asset-completion-jwt' } }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ success: true, result: { id: workerVersionId } }))
      .mockResolvedValueOnce(Response.json({ success: true, result: { id: providerDeploymentId, versions } }))
      .mockResolvedValueOnce(Response.json({ success: true, result: { id: providerDeploymentId, versions } }));
    const api = new UserCloudflareAccountApi('account-1', 'oauth-token', request);

    await expect(
      api.deployManagedWorker({
        workerName: 'ghostbuild-app',
        projectType: 'web_app',
        sourceSha256: 'a'.repeat(64),
        mainModule: 'index.js',
        modules: [module],
        assets: [asset, duplicateAsset],
        workersAi: true,
        appAgent: true,
        d1DatabaseId: '0123456789abcdef0123456789abcdef',
        agentSecurityD1DatabaseId: 'abcdef0123456789abcdef0123456789',
        r2BucketName: 'ghostbuild-storage',
        securityBaselineVersion: '24',
        securityBoundarySha256: 'b'.repeat(64),
        templateSourceSha256: 'c'.repeat(64),
      }),
    ).resolves.toEqual({ workerVersionId });

    expect(request.mock.calls.map(([url]) => String(url))).toEqual([
      'https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts/ghostbuild-app/assets-upload-session',
      'https://api.cloudflare.com/client/v4/accounts/account-1/workers/assets/upload?base64=true',
      'https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts/ghostbuild-app/versions',
      'https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts/ghostbuild-app/deployments',
      `https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts/ghostbuild-app/deployments/${providerDeploymentId}`,
    ]);
    expect(request.mock.calls.every(([, init]) => init?.redirect === 'manual')).toBe(true);
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      manifest: {
        '/index.html': { hash: assetHash, size: asset.size },
        '/nested/index.html': { hash: assetHash, size: duplicateAsset.size },
      },
    });
    expect(request.mock.calls[1]?.[1]?.headers).toMatchObject({ authorization: 'Bearer asset-session-jwt' });
    expect([...(request.mock.calls[1]?.[1]?.body as FormData).keys()]).toEqual([assetHash]);
    const versionForm = request.mock.calls[2]?.[1]?.body as FormData;
    const metadata = JSON.parse(await (versionForm.get('metadata') as Blob).text()) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      main_module: 'index.js',
      assets: { jwt: 'asset-completion-jwt' },
      compatibility_date: '2026-07-21',
    });
    expect(JSON.stringify(metadata)).not.toMatch(/oauth-token|CLOUDFLARE_API_TOKEN|apiToken/);
    expect(versionForm.get('index.js')).toBeInstanceOf(Blob);
    expect(JSON.parse(String(request.mock.calls[3]?.[1]?.body))).toMatchObject({
      strategy: 'percentage',
      versions,
    });
  });

  test('rejects unknown asset bucket hashes and a missing final completion JWT', async () => {
    const module = await artifactFile('index.js', 'export default {}');
    const asset = await artifactFile('index.html', '<h1>Ghostbuild</h1>');
    const deploy = (request: typeof fetch) =>
      new UserCloudflareAccountApi('account-1', 'token', request).deployManagedWorker({
        workerName: 'ghostbuild-app',
        projectType: 'web_app',
        sourceSha256: 'a'.repeat(64),
        mainModule: 'index.js',
        modules: [module],
        assets: [asset],
        workersAi: false,
        appAgent: false,
        securityBaselineVersion: '24',
        securityBoundarySha256: 'b'.repeat(64),
        templateSourceSha256: 'c'.repeat(64),
      });
    const unknownBucket = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ success: true, result: { jwt: 'session-jwt', buckets: [['f'.repeat(32)]] } }),
      );
    await expect(deploy(unknownBucket)).rejects.toThrow('unknown managed Worker asset');
    expect(unknownBucket).toHaveBeenCalledOnce();

    const assetHash = await deploymentAssetHash(asset);
    const missingCompletion = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ success: true, result: { jwt: 'session-jwt', buckets: [[assetHash]] } }))
      .mockResolvedValueOnce(Response.json({ success: true, result: {} }, { status: 201 }));
    await expect(deploy(missingCompletion)).rejects.toThrow('invalid asset upload identity');
    expect(missingCompletion).toHaveBeenCalledTimes(2);
  });

  test('forces one credential refresh and retries exactly once on a Cloudflare 401', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ success: false }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ success: true, result: { subdomain: 'fresh-subdomain' } }));
    const refreshAccessToken = vi.fn(async () => 'fresh-token');
    const api = new UserCloudflareAccountApi('account-1', 'expired-token', request, undefined, refreshAccessToken);

    await expect(api.getWorkersSubdomain()).resolves.toBe('fresh-subdomain');
    expect(refreshAccessToken).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: 'Bearer expired-token' });
    expect(request.mock.calls[1]?.[1]?.headers).toMatchObject({ authorization: 'Bearer fresh-token' });
  });

  test('does not loop when Cloudflare rejects the forced-refresh retry', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ success: false }, { status: 401 }));
    const refreshAccessToken = vi.fn(async () => 'fresh-token');
    const api = new UserCloudflareAccountApi('account-1', 'expired-token', request, undefined, refreshAccessToken);

    await expect(api.getWorkersSubdomain()).rejects.toThrow('Cloudflare API request failed (401)');
    expect(refreshAccessToken).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledTimes(2);
  });

  test('reads back the exact managed schedule and public subdomain state', async () => {
    const schedule = { schedules: [{ cron: '0 3 * * *' }] };
    const subdomain = { enabled: true, previews_enabled: false };
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ success: true, result: schedule }))
      .mockResolvedValueOnce(Response.json({ success: true, result: schedule }))
      .mockResolvedValueOnce(Response.json({ success: true, result: subdomain }))
      .mockResolvedValueOnce(Response.json({ success: true, result: subdomain }));
    const api = new UserCloudflareAccountApi('account-1', 'token', request);

    await expect(api.configureManagedWorkerSchedule('ghostbuild-app', true)).resolves.toBeUndefined();
    await expect(api.enableWorkerSubdomain('ghostbuild-app')).resolves.toBeUndefined();
    expect(request.mock.calls.map(([, init]) => init?.method)).toEqual(['PUT', 'GET', 'POST', 'GET']);
  });

  test('rejects missing schedule readback when the expected schedule set is empty', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ success: true, result: {} }))
      .mockResolvedValueOnce(Response.json({ success: true, result: {} }));

    await expect(
      new UserCloudflareAccountApi('account-1', 'token', request).configureManagedWorkerSchedule(
        'ghostbuild-app',
        false,
      ),
    ).rejects.toThrow('invalid managed Worker schedules');
  });

  test('deploys the Computer workspace and execution bindings into the user account', async () => {
    const workerVersionId = '33333333-3333-4333-8333-333333333333';
    const providerDeploymentId = '44444444-4444-4444-8444-444444444444';
    const versions = [{ percentage: 100, version_id: workerVersionId }];
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ success: true, result: { id: workerVersionId } }))
      .mockResolvedValueOnce(Response.json({ success: true, result: { id: providerDeploymentId, versions } }))
      .mockResolvedValueOnce(Response.json({ success: true, result: { id: providerDeploymentId, versions } }))
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: [
            {
              id: '0123456789abcdef0123456789abcdef',
              class: 'ProjectWorkspace',
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
        controlPlaneSecret: 'control-plane-secret-that-is-long-enough',
        runtimeVersion: 'a'.repeat(64),
        databaseId: '0123456789abcdef0123456789abcdef',
        userId: 'user-1',
        connectionId: 'connection-1',
        connectionGeneration: 1,
        endpoint: 'https://ghostbuild-workspace-user.example.workers.dev',
      }),
    ).resolves.toEqual({
      workerVersionId,
      namespaceId: '0123456789abcdef0123456789abcdef',
    });

    const [scriptUrl, scriptInit] = request.mock.calls[0];
    expect(scriptUrl).toBe(
      'https://api.cloudflare.com/client/v4/accounts/user-account/workers/scripts/ghostbuild-workspace-user/versions',
    );
    expect(scriptInit).toMatchObject({ method: 'POST', headers: { authorization: 'Bearer user-token' } });
    const form = scriptInit?.body as FormData;
    const metadataPart = form.get('metadata');
    expect(metadataPart).toBeInstanceOf(Blob);
    const metadata = JSON.parse(await (metadataPart as Blob).text()) as {
      bindings: Array<Record<string, string>>;
      compatibility_flags: string[];
      containers: Array<{ class_name: string }>;
      exports: Record<string, unknown>;
      observability: unknown;
    };
    expect(metadata.compatibility_flags).toEqual(expect.arrayContaining(['nodejs_compat', 'experimental']));
    expect(metadata.containers).toEqual([{ class_name: 'ProjectWorkspace' }]);
    expect(metadata.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'durable_object_namespace',
          name: 'PROJECT_WORKSPACE',
          class_name: 'ProjectWorkspace',
        }),
        expect.objectContaining({ type: 'worker_loader', name: 'LOADER' }),
        expect.objectContaining({ type: 'plain_text', name: 'SANDBOX_TRANSPORT', text: 'rpc' }),
        expect.objectContaining({
          type: 'plain_text',
          name: 'GHOSTBUILD_CONTROL_PLANE_ENDPOINT',
          text: 'https://ghostbuild.dev',
        }),
      ]),
    );
    expect(metadata.bindings).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: 'r2_bucket' })]));
    expect(metadata.bindings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'CLOUDFLARE_API_TOKEN' })]),
    );
    expect(metadata.exports).toHaveProperty('ProjectWorkspace');
    expect(metadata.observability).toEqual({
      enabled: true,
      logs: { enabled: true, head_sampling_rate: 0.6 },
    });
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
      max_instances: 10,
      durable_objects: { namespace_id: '0123456789abcdef0123456789abcdef' },
    });
  });

  test('rejects a matching container application without provider identity', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json([{ name: 'ghostbuild-workspace-user' }]));
    const api = new UserCloudflareAccountApi('user-account', 'user-token', request);

    await expect(
      api.ensureWorkspaceRuntimeContainer({
        applicationName: 'ghostbuild-workspace-user',
        namespaceId: '0123456789abcdef0123456789abcdef',
        image: `docker.io/cloudflare/sandbox:0.12.4@sha256:${'b'.repeat(64)}`,
      }),
    ).rejects.toThrow('invalid workspace container application');
    expect(request).toHaveBeenCalledOnce();
  });
});
