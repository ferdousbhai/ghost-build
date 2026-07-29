import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { CloudflareConnection } from './cloudflare-connection-repository';
import type { Deployment } from './deployment-repository';

const sandbox = vi.hoisted(() => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  exec: vi.fn(),
  readFile: vi.fn(),
  destroy: vi.fn(),
}));
const mocks = vi.hoisted(() => ({
  getSandbox: vi.fn((_namespace: unknown, _id: string, _options?: unknown) => sandbox),
}));
vi.mock('@cloudflare/sandbox', () => ({ getSandbox: mocks.getSandbox }));

import { publishDeploymentBuild } from './deployment-publish-executor';
import {
  APP_AGENT_SECURITY_BOUNDARY_SHA256,
  DEPLOYMENT_SECURITY_BASELINE_VERSION,
  TEMPLATE_SOURCE_SHA256,
} from './deployment-security-baseline';
import { DEPLOYMENT_COMPATIBILITY_DATE } from './deployment-runtime-policy';

describe('publishDeploymentBuild', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sandbox.mkdir.mockResolvedValue({ success: true });
    sandbox.writeFile.mockResolvedValue({ success: true });
    sandbox.exec.mockResolvedValue({ success: true, exitCode: 0, stdout: '', stderr: '', command: 'ok' });
    sandbox.readFile.mockResolvedValue({
      success: true,
      content:
        '{"type":"wrangler-session","version":1}\n' +
        '{"type":"deploy","version":1,"worker_name":"ghostbuild-deployment-1","version_id":"11111111-1111-4111-8111-111111111111"}\n',
    });
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
      agentSecurityD1DatabaseId: 'agent-security-d1-id',
      r2BucketName: 'ghostbuild-deployment-1-storage',
    });

    const configCall = sandbox.writeFile.mock.calls.find((call) => call[0] === '/workspace/publish/wrangler.json');
    const config = JSON.parse(configCall?.[1] as string) as Record<string, unknown>;
    expect(config).toMatchObject({
      name: 'ghostbuild-deployment-1',
      account_id: 'account-1',
      no_bundle: true,
      compatibility_date: DEPLOYMENT_COMPATIBILITY_DATE,
      compatibility_flags: ['nodejs_compat'],
      ai: { binding: 'AI' },
      durable_objects: { bindings: [{ name: 'AppAgent', class_name: 'AppAgent' }] },
      exports: { AppAgent: { type: 'durable-object', storage: 'sqlite' } },
      triggers: { crons: ['0 3 * * *'] },
      version_metadata: { binding: 'CF_VERSION_METADATA' },
      vars: {
        GHOSTBUILD_SECURITY_BASELINE_VERSION: String(DEPLOYMENT_SECURITY_BASELINE_VERSION),
        GHOSTBUILD_SECURITY_BOUNDARY_SHA256: APP_AGENT_SECURITY_BOUNDARY_SHA256,
        GHOSTBUILD_TEMPLATE_SOURCE_SHA256: TEMPLATE_SOURCE_SHA256,
      },
      observability: {
        enabled: true,
        logs: { enabled: true, head_sampling_rate: 0.6 },
        traces: { enabled: true, head_sampling_rate: 0.05 },
      },
      upload_source_maps: true,
    });
    expect(config).not.toHaveProperty('migrations');
    expect(config.d1_databases).toEqual([
      {
        binding: 'DB',
        database_name: 'ghostbuild-deployment-1',
        database_id: 'd1-id',
        migrations_dir: 'migrations',
      },
      {
        binding: 'AGENT_SECURITY_DB',
        database_name: 'ghostbuild-deployment-1-agent-security',
        database_id: 'agent-security-d1-id',
        migrations_dir: 'agent-security-migrations',
      },
    ]);
    expect(JSON.stringify(config)).not.toContain('real-user-token');

    const sandboxId = mocks.getSandbox.mock.calls[0]?.[1] as string;
    expect(sandboxId.length).toBeLessThanOrEqual(63);
    expect(sandboxId).toMatch(/^[a-z0-9-]+$/);

    const deployCall = sandbox.exec.mock.calls.find((call) => call[0] === 'wrangler deploy --config wrangler.json');
    const proxyToken = deployCall?.[1]?.env?.CLOUDFLARE_API_TOKEN as string;
    expect(proxyToken.split('.')).toHaveLength(3);
    expect(proxyToken).not.toBe('real-user-token');
    expect(deployCall?.[1]?.env).toMatchObject({ CLOUDFLARE_ACCOUNT_ID: 'account-1' });
    const commands = sandbox.exec.mock.calls.map((call) => call[0] as string);
    expect(commands[0]).toBe('rm -rf /workspace/publish /workspace/build.tar.gz /workspace/wrangler-output.ndjson');
    const archiveValidation = commands.findIndex((command) => command.startsWith('tar -tzf '));
    const archiveExtraction = commands.findIndex((command) => command.startsWith('tar -xzf '));
    expect(archiveValidation).toBeGreaterThan(-1);
    expect(archiveExtraction).toBeGreaterThan(archiveValidation);
    expect(commands[archiveValidation]).toContain("grep -Ev '^[-d]$'");
    expect(commands[archiveExtraction]).toContain('--no-same-owner --no-same-permissions --keep-old-files');
    expect(commands).toContain('wrangler d1 migrations apply DB --remote --config wrangler.json --yes');
    expect(commands).toContain('wrangler d1 migrations apply AGENT_SECURITY_DB --remote --config wrangler.json --yes');
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  test('rejects a stale approved plan before creating a publish sandbox', async () => {
    const stale = deployment();
    stale.plan = { ...stale.plan, version: 1 } as unknown as Deployment['plan'];

    await expect(
      publishDeploymentBuild({
        env: {
          DeploymentSandbox: {},
          DEPLOYMENT_PROXY_JWT_SECRET: btoa('0123456789abcdef0123456789abcdef'),
        } as unknown as Env,
        deployment: stale,
        connection: connection(),
        build: new Uint8Array([1]),
      }),
    ).rejects.toThrow('security baseline is stale');

    expect(sandbox.exec).not.toHaveBeenCalled();
  });

  test('rejects a connection generation that no longer matches the approved deployment', async () => {
    const rotated = connection();
    rotated.generation = 2;

    await expect(
      publishDeploymentBuild({
        env: {
          DeploymentSandbox: {},
          DEPLOYMENT_PROXY_JWT_SECRET: btoa('0123456789abcdef0123456789abcdef'),
        } as unknown as Env,
        deployment: deployment(),
        connection: rotated,
        build: new Uint8Array([1]),
      }),
    ).rejects.toThrow('no longer matches the approved deployment');

    expect(sandbox.exec).not.toHaveBeenCalled();
  });

  test('fails closed unless AppAgent uses a separate provisioned security database', async () => {
    const args = {
      env: {
        DeploymentSandbox: {},
        DEPLOYMENT_PROXY_JWT_SECRET: btoa('0123456789abcdef0123456789abcdef'),
      } as unknown as Env,
      deployment: deployment(),
      connection: connection(),
      build: new Uint8Array([1]),
      d1DatabaseId: 'd1-id',
      r2BucketName: 'ghostbuild-deployment-1-storage',
    };

    await expect(publishDeploymentBuild(args)).rejects.toThrow('agent security D1 resource result');
    await expect(publishDeploymentBuild({ ...args, agentSecurityD1DatabaseId: 'd1-id' })).rejects.toThrow(
      'must be separate',
    );
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
        agentSecurityD1DatabaseId: 'agent-security-d1-id',
        r2BucketName: 'ghostbuild-deployment-1-storage',
      }),
    ).rejects.toThrow('denied');
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  test('resets the deterministic publish workspace before retrying after destroy failure', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    sandbox.destroy.mockRejectedValueOnce(new Error('destroy timed out'));
    const args = {
      env: {
        DeploymentSandbox: {},
        DEPLOYMENT_PROXY_JWT_SECRET: btoa('0123456789abcdef0123456789abcdef'),
      } as unknown as Env,
      deployment: deployment(),
      connection: connection(),
      build: new Uint8Array([1]),
      d1DatabaseId: 'd1-id',
      agentSecurityD1DatabaseId: 'agent-security-d1-id',
      r2BucketName: 'ghostbuild-deployment-1-storage',
    };

    await expect(publishDeploymentBuild(args)).resolves.toEqual({
      workerVersionId: '11111111-1111-4111-8111-111111111111',
    });
    await expect(publishDeploymentBuild(args)).resolves.toEqual({
      workerVersionId: '11111111-1111-4111-8111-111111111111',
    });

    expect(
      sandbox.exec.mock.calls.filter(
        ([command]) =>
          command === 'rm -rf /workspace/publish /workspace/build.tar.gz /workspace/wrangler-output.ndjson',
      ),
    ).toHaveLength(2);
    expect(consoleError).toHaveBeenCalledWith('Unable to destroy deployment publish sandbox', expect.any(Error));
    consoleError.mockRestore();
  });

  test('rejects missing or ambiguous Wrangler version output after publish', async () => {
    sandbox.readFile.mockResolvedValueOnce({ success: true, content: '{"type":"wrangler-session","version":1}\n' });
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
        agentSecurityD1DatabaseId: 'agent-security-d1-id',
        r2BucketName: 'ghostbuild-deployment-1-storage',
      }),
    ).rejects.toThrow('exactly one published Worker version');
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
    expect(config).not.toHaveProperty('exports');
    expect(config).not.toHaveProperty('triggers');
    expect(config).not.toHaveProperty('migrations');
    expect(sandbox.exec.mock.calls.map((call) => call[0])).not.toContain(
      'wrangler d1 migrations apply DB --remote --config wrangler.json --yes',
    );
  });
});

function deployment(): Deployment {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    chatId: 'chat-1',
    userId: 'user-1',
    connectionId: 'connection-1',
    connectionGeneration: 1,
    executionGeneration: 1,
    buildArtifactKey: 'build-key',
    buildArtifactGeneration: 1,
    snapshotKey: 'snapshot-1',
    status: 'deploying',
    plan: {
      version: 2,
      deploymentId: '11111111-2222-4333-8444-555555555555',
      sourceSha256: 'a'.repeat(64),
      templateSourceSha256: TEMPLATE_SOURCE_SHA256,
      securityBaselineVersion: DEPLOYMENT_SECURITY_BASELINE_VERSION,
      securityBoundarySha256: APP_AGENT_SECURITY_BOUNDARY_SHA256,
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
        {
          type: 'd1',
          logicalName: 'AGENT_SECURITY_DB',
          proposedName: 'ghostbuild-deployment-1-agent-security',
        },
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
