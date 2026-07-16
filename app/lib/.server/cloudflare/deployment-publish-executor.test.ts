import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { CloudflareConnection } from './cloudflare-connection-repository';
import type { Deployment } from './deployment-repository';

const sandbox = vi.hoisted(() => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  exec: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn(() => sandbox) }));

import { publishDeploymentBuild } from './deployment-publish-executor';

describe('publishDeploymentBuild', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sandbox.mkdir.mockResolvedValue({ success: true });
    sandbox.writeFile.mockResolvedValue({ success: true });
    sandbox.exec.mockResolvedValue({ success: true, exitCode: 0, stdout: '', stderr: '', command: 'ok' });
    sandbox.destroy.mockResolvedValue(undefined);
  });

  test('publishes from trusted configuration with only a short-lived proxy token', async () => {
    await publishDeploymentBuild({
      env: {
        DeploymentSandbox: {},
        DEPLOYMENT_PROXY_JWT_SECRET: btoa('0123456789abcdef0123456789abcdef'),
      } as unknown as Env,
      deployment: deployment(),
      connection: connection(),
      build: new Uint8Array([1, 2, 3]),
      d1DatabaseId: 'd1-id',
      r2BucketName: 'ghostbuild-deployment-1-storage',
    });

    const configCall = sandbox.writeFile.mock.calls.find((call) => call[0] === '/workspace/publish/wrangler.json');
    const config = JSON.parse(configCall?.[1] as string) as Record<string, unknown>;
    expect(config).toMatchObject({
      name: 'ghostbuild-deployment-1',
      account_id: 'account-1',
      no_bundle: true,
      ai: { binding: 'AI' },
      observability: {
        enabled: true,
        logs: { enabled: true, head_sampling_rate: 0.6 },
        traces: { enabled: true, head_sampling_rate: 0.05 },
      },
      upload_source_maps: true,
    });
    expect(JSON.stringify(config)).not.toContain('real-user-token');

    const deployCall = sandbox.exec.mock.calls.find((call) => call[0] === 'wrangler deploy --config wrangler.json');
    const proxyToken = deployCall?.[1]?.env?.CLOUDFLARE_API_TOKEN as string;
    expect(proxyToken.split('.')).toHaveLength(3);
    expect(proxyToken).not.toBe('real-user-token');
    expect(deployCall?.[1]?.env).toMatchObject({ CLOUDFLARE_ACCOUNT_ID: 'account-1' });
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  test('destroys the publish sandbox when Wrangler fails', async () => {
    sandbox.exec.mockImplementation(async (command: string) =>
      command === 'wrangler deploy --config wrangler.json'
        ? { success: false, exitCode: 1, stdout: '', stderr: 'denied', command }
        : { success: true, exitCode: 0, stdout: '', stderr: '', command },
    );
    await expect(
      publishDeploymentBuild({
        env: {
          DeploymentSandbox: {},
          DEPLOYMENT_PROXY_JWT_SECRET: btoa('0123456789abcdef0123456789abcdef'),
        } as unknown as Env,
        deployment: deployment(),
        connection: connection(),
        build: new Uint8Array([1]),
        d1DatabaseId: 'd1-id',
        r2BucketName: 'ghostbuild-deployment-1-storage',
      }),
    ).rejects.toThrow('denied');
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  test('publishes a Worker-only build without TanStack assets or unused bindings', async () => {
    const workerDeployment = deployment();
    workerDeployment.plan.project = {
      type: 'worker',
      bindings: { ai: false, d1: false, r2: false, appAgent: false },
    };
    workerDeployment.plan.resources = workerDeployment.plan.resources.filter((resource) => resource.type === 'worker');
    await publishDeploymentBuild({
      env: {
        DeploymentSandbox: {},
        DEPLOYMENT_PROXY_JWT_SECRET: btoa('0123456789abcdef0123456789abcdef'),
      } as unknown as Env,
      deployment: workerDeployment,
      connection: connection(),
      build: new Uint8Array([1]),
    });
    const configCall = sandbox.writeFile.mock.calls.find((call) => call[0] === '/workspace/publish/wrangler.json');
    const config = JSON.parse(configCall?.[1] as string) as Record<string, unknown>;
    expect(config).toMatchObject({ main: 'dist/worker/server.js', no_bundle: true });
    expect(config).not.toHaveProperty('assets');
    expect(config).not.toHaveProperty('d1_databases');
    expect(config).not.toHaveProperty('r2_buckets');
    expect(config).not.toHaveProperty('durable_objects');
    expect(sandbox.exec.mock.calls.map((call) => call[0])).not.toContain(
      'wrangler d1 migrations apply DB --remote --config wrangler.json --yes',
    );
  });
});

function deployment(): Deployment {
  return {
    id: 'deployment-1',
    chatId: 'chat-1',
    userId: 'user-1',
    connectionId: 'connection-1',
    connectionGeneration: 1,
    snapshotKey: 'snapshot-1',
    status: 'deploying',
    plan: {
      version: 1,
      deploymentId: 'deployment-1',
      sourceSha256: 'a'.repeat(64),
      project: {
        type: 'web_app',
        bindings: { ai: true, d1: true, r2: true, appAgent: true },
      },
      billing: {
        infrastructure: 'user_cloudflare_account',
        workersAi: 'user_cloudflare_account',
        workersPaidUpgrade: 'explicit_user_authorization_required',
      },
      resources: [
        { type: 'worker', logicalName: 'app', proposedName: 'ghostbuild-deployment-1' },
        { type: 'd1', logicalName: 'DB', proposedName: 'ghostbuild-deployment-1' },
        { type: 'r2', logicalName: 'APP_STORAGE', proposedName: 'ghostbuild-deployment-1-storage' },
        { type: 'durable_object', logicalName: 'AppAgent', proposedName: 'AppAgent' },
        { type: 'workers_ai', logicalName: 'AI', proposedName: 'AI' },
      ],
    },
    planDigest: 'a'.repeat(64),
    approvedDigest: 'a'.repeat(64),
    approvedAt: 1,
    productionUrl: null,
    errorCode: null,
    errorMessage: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function connection(): CloudflareConnection {
  return {
    id: 'connection-1',
    userId: 'user-1',
    accountId: 'account-1',
    accountName: 'Account',
    status: 'active',
    credentialHandle: 'credential-1',
    grantedScopes: [],
    aiBillingEnabled: true,
    connectedAt: 1,
    updatedAt: 1,
    generation: 1,
  };
}
