import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  listDeploymentResources: vi.fn(),
  requireActiveCloudflareConnection: vi.fn(),
  requireDeployment: vi.fn(),
  resolveCredential: vi.fn(),
}));

vi.mock('./cloudflare-connection-repository', () => ({
  requireActiveCloudflareConnection: mocks.requireActiveCloudflareConnection,
}));
vi.mock('./cloudflare-credential-vault', () => ({
  D1CloudflareCredentialVault: { fromEnv: () => ({ resolve: mocks.resolveCredential }) },
}));
vi.mock('./deployment-repository', () => ({
  listDeploymentResources: mocks.listDeploymentResources,
  requireDeployment: mocks.requireDeployment,
}));

import { isApprovedCloudflareApiRequest, proxyApprovedCloudflareRequest } from './deployment-egress-proxy';
import { createDeploymentProxyToken, deploymentPublishContainerId } from './deployment-proxy-token';

const account = 'account-1';
const deploymentId = '11111111-2222-4333-8444-555555555555';
const plan = {
  resources: [{ type: 'worker', logicalName: 'app', proposedName: 'ghostbuild-deployment-1' }],
};
const resources = [
  { resourceType: 'd1', logicalName: 'DB', providerResourceId: 'd1-id' },
  { resourceType: 'd1', logicalName: 'AGENT_SECURITY_DB', providerResourceId: 'agent-security-d1-id' },
  { resourceType: 'r2', logicalName: 'APP_STORAGE', providerResourceId: 'ghostbuild-deployment-1-storage' },
];

const secret = btoa('0123456789abcdef0123456789abcdef');

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.fetch.mockResolvedValue(new Response('ok'));
  mocks.listDeploymentResources.mockResolvedValue([]);
  mocks.resolveCredential.mockResolvedValue('current-access-token');
});

describe('deployment Cloudflare API allowlist', () => {
  test('allows only exact approved Worker and D1 deployment operations', () => {
    expect(allowed('PUT', `/accounts/${account}/workers/scripts/ghostbuild-deployment-1`)).toBe(true);
    expect(allowed('PUT', `/accounts/${account}/workers/scripts/ghostbuild-deployment-1/schedules`)).toBe(true);
    expect(allowed('POST', `/accounts/${account}/d1/database/d1-id/query`)).toBe(true);
    expect(allowed('POST', `/accounts/${account}/d1/database/agent-security-d1-id/query`)).toBe(true);
    expect(allowed('GET', `/accounts/${account}/d1/database/agent-security-d1-id`)).toBe(true);
    expect(allowed('POST', `/accounts/${account}/workers/scripts/ghostbuild-deployment-1/assets-upload-session`)).toBe(
      true,
    );
    expect(allowed('GET', `/accounts/${account}/r2/buckets`)).toBe(true);
  });

  test('denies other accounts, resources, deletion, and every billing or subscription mutation', () => {
    expect(allowed('PUT', '/accounts/another/workers/scripts/ghostbuild-deployment-1')).toBe(false);
    expect(allowed('PUT', `/accounts/${account}/workers/scripts/unapproved-worker`)).toBe(false);
    expect(allowed('PUT', `/accounts/${account}/workers/scripts/unapproved-worker/schedules`)).toBe(false);
    expect(allowed('DELETE', `/accounts/${account}/workers/scripts/ghostbuild-deployment-1/schedules`)).toBe(false);
    expect(allowed('POST', `/accounts/${account}/d1/database/another-id/query`)).toBe(false);
    expect(allowed('POST', `/accounts/${account}/d1/database/unrecorded-security-id/query`)).toBe(false);
    expect(allowed('GET', `/accounts/${account}/d1/database`)).toBe(false);
    expect(allowed('POST', `/accounts/${account}/d1/database/d1-id/export`)).toBe(false);
    expect(allowed('POST', `/accounts/${account}/d1/database/d1-id/import`)).toBe(false);
    expect(allowed('DELETE', `/accounts/${account}/workers/scripts/ghostbuild-deployment-1`)).toBe(false);
    expect(allowed('POST', `/accounts/${account}/subscriptions`)).toBe(false);
    expect(allowed('PUT', `/accounts/${account}/workers/subdomain`)).toBe(false);
    expect(allowed('GET', `/accounts/${account}/billing/profile`)).toBe(false);
  });

  test('denies non-Cloudflare and non-HTTPS destinations', () => {
    expect(
      isApprovedCloudflareApiRequest(
        'PUT',
        new URL(`https://attacker.example/client/v4/accounts/${account}/workers/scripts/ghostbuild-deployment-1`),
        account,
        plan,
        resources,
      ),
    ).toBe(false);
    expect(
      isApprovedCloudflareApiRequest(
        'PUT',
        new URL(`http://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/ghostbuild-deployment-1`),
        account,
        plan,
        resources,
      ),
    ).toBe(false);
  });
});

describe('deployment Cloudflare API proxy authorization', () => {
  test('rejects a token issued before a same-account connection rotation without resolving the new credential', async () => {
    mocks.requireDeployment.mockResolvedValue(deployment({ connectionGeneration: 1, executionGeneration: 1 }));
    mocks.requireActiveCloudflareConnection.mockResolvedValue(connection(2));

    const response = await proxyRequest({ connectionGeneration: 1, executionGeneration: 1 });

    expect(response.status).toBe(403);
    expect(mocks.resolveCredential).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  test('rejects a token issued for an earlier deployment execution without resolving a credential', async () => {
    mocks.requireDeployment.mockResolvedValue(deployment({ connectionGeneration: 1, executionGeneration: 2 }));
    mocks.requireActiveCloudflareConnection.mockResolvedValue(connection(1));

    const response = await proxyRequest({ connectionGeneration: 1, executionGeneration: 1 });

    expect(response.status).toBe(409);
    expect(mocks.requireActiveCloudflareConnection).not.toHaveBeenCalled();
    expect(mocks.resolveCredential).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  test('uses the current credential when both signed generations match current deployment state', async () => {
    mocks.requireDeployment.mockResolvedValue(deployment({ connectionGeneration: 2, executionGeneration: 3 }));
    mocks.requireActiveCloudflareConnection.mockResolvedValue(connection(2));

    const response = await proxyRequest({ connectionGeneration: 2, executionGeneration: 3 });

    expect(response.status).toBe(200);
    expect(mocks.resolveCredential).toHaveBeenCalledWith('credential-current');
    expect(mocks.fetch).toHaveBeenCalledOnce();
    const upstream = mocks.fetch.mock.calls[0][0] as Request;
    expect(upstream.headers.get('authorization')).toBe('Bearer current-access-token');
  });

  test('rejects provider-issued asset authorization from an earlier execution container', async () => {
    mocks.requireDeployment.mockResolvedValue(deployment({ connectionGeneration: 1, executionGeneration: 2 }));

    const response = await proxyAssetRequest({ connectionGeneration: 1, executionGeneration: 1 });

    expect(response.status).toBe(409);
    expect(mocks.requireActiveCloudflareConnection).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  test('rejects asset upload after connection rotation and preserves provider authorization for current state', async () => {
    mocks.requireDeployment.mockResolvedValue(deployment({ connectionGeneration: 1, executionGeneration: 1 }));
    mocks.requireActiveCloudflareConnection.mockResolvedValueOnce(connection(2)).mockResolvedValueOnce(connection(1));

    const staleResponse = await proxyAssetRequest({ connectionGeneration: 1, executionGeneration: 1 });
    const currentResponse = await proxyAssetRequest({ connectionGeneration: 1, executionGeneration: 1 });

    expect(staleResponse.status).toBe(403);
    expect(currentResponse.status).toBe(200);
    expect(mocks.resolveCredential).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledOnce();
    const upstream = mocks.fetch.mock.calls[0][0] as Request;
    expect(upstream.headers.get('authorization')).toBe('Bearer provider-assets-token');
  });
});

function allowed(method: string, path: string): boolean {
  return isApprovedCloudflareApiRequest(
    method,
    new URL(`https://api.cloudflare.com/client/v4${path}`),
    account,
    plan,
    resources,
  );
}

async function proxyRequest(generations: {
  connectionGeneration: number;
  executionGeneration: number;
}): Promise<Response> {
  const token = await createDeploymentProxyToken({
    secretBase64: secret,
    deploymentId,
    accountId: account,
    connectionGeneration: generations.connectionGeneration,
    executionGeneration: generations.executionGeneration,
    planDigest: 'a'.repeat(64),
    containerId: 'publish-deployment-1',
  });
  return proxyApprovedCloudflareRequest(
    new Request(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/ghostbuild-deployment-1`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}` },
    }),
    {
      DB: {},
      CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY: 'configured',
      DEPLOYMENT_PROXY_JWT_SECRET: secret,
    } as unknown as Env,
    { containerId: 'publish-deployment-1' },
  );
}

function deployment(generations: { connectionGeneration: number; executionGeneration: number }) {
  return {
    id: deploymentId,
    connectionId: 'connection-1',
    connectionGeneration: generations.connectionGeneration,
    executionGeneration: generations.executionGeneration,
    status: 'deploying',
    plan,
    planDigest: 'a'.repeat(64),
    approvedDigest: 'a'.repeat(64),
  };
}

function connection(generation: number) {
  return {
    accountId: account,
    credentialHandle: 'credential-current',
    generation,
  };
}

function proxyAssetRequest(generations: { connectionGeneration: number; executionGeneration: number }) {
  return proxyApprovedCloudflareRequest(
    new Request(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/assets/upload`, {
      method: 'POST',
      headers: { authorization: 'Bearer provider-assets-token' },
    }),
    {
      DB: {},
      CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY: 'configured',
      DEPLOYMENT_PROXY_JWT_SECRET: secret,
    } as unknown as Env,
    {
      containerId: deploymentPublishContainerId({ deploymentId, ...generations }),
    },
  );
}
