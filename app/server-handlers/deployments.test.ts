import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findConnection: vi.fn(),
  createDeployment: vi.fn(),
  requireDeployment: vi.fn(),
  approveDeployment: vi.fn(),
  adoptExecutionGeneration: vi.fn(),
  executeUserOwnedDeployment: vi.fn(),
}));

vi.mock('~/lib/.server/cloudflare/cloudflare-connection-repository', () => ({
  findCloudflareConnectionForUser: mocks.findConnection,
}));
vi.mock('~/lib/.server/cloudflare/deployment-repository', async (importOriginal) => ({
  ...(await importOriginal()),
  createDeployment: mocks.createDeployment,
  requireDeploymentForUser: mocks.requireDeployment,
  approveDeployment: mocks.approveDeployment,
  adoptLegacyApprovedDeploymentExecutionGeneration: mocks.adoptExecutionGeneration,
}));
vi.mock('~/lib/.server/cloudflare/user-workspace-deployment-executor', () => ({
  executeUserOwnedDeployment: mocks.executeUserOwnedDeployment,
}));

import {
  APP_AGENT_SECURITY_BOUNDARY_SHA256,
  DEPLOYMENT_SECURITY_BASELINE_VERSION,
  TEMPLATE_SOURCE_SHA256,
} from '~/lib/.server/cloudflare/deployment-security-baseline';
import { createOrReplayDeploymentPlanForUser, userRuntimeDeploymentAction } from './deployments';

const project = { type: 'web_app' as const, bindings: { ai: true, d1: true, r2: true, appAgent: true } };
const revision = 'a'.repeat(64);

function deployment(status = 'awaiting_approval') {
  const plan = {
    version: 2 as const,
    deploymentId: 'deployment-1',
    sourceSha256: revision,
    templateSourceSha256: TEMPLATE_SOURCE_SHA256,
    securityBaselineVersion: DEPLOYMENT_SECURITY_BASELINE_VERSION,
    securityBoundarySha256: APP_AGENT_SECURITY_BOUNDARY_SHA256,
    project,
    billing: {
      infrastructure: 'user_cloudflare_account' as const,
      workersAi: 'user_cloudflare_account' as const,
      workersPaidUpgrade: 'explicit_user_authorization_required' as const,
    },
    resources: [
      { type: 'worker' as const, logicalName: 'app', proposedName: 'ghostbuild-deployment-1' },
      { type: 'd1' as const, logicalName: 'DB', proposedName: 'ghostbuild-deployment-1' },
      {
        type: 'd1' as const,
        logicalName: 'AGENT_SECURITY_DB',
        proposedName: 'ghostbuild-deployment-1-agent-security',
      },
      { type: 'r2' as const, logicalName: 'APP_STORAGE', proposedName: 'ghostbuild-deployment-1-storage' },
      { type: 'durable_object' as const, logicalName: 'AppAgent', proposedName: 'AppAgent' },
      { type: 'workers_ai' as const, logicalName: 'AI', proposedName: 'AI' },
    ],
  };
  return {
    id: 'deployment-1',
    chatId: 'chat-row-1',
    userId: 'user-1',
    connectionId: 'connection-1',
    connectionGeneration: 1,
    executionGeneration: 1,
    snapshotKey: `workspace-runtime:agent-1:7:${revision}`,
    status,
    plan,
    planDigest: 'b'.repeat(64),
    approvedDigest: status === 'approved' ? 'b'.repeat(64) : null,
    approvedAt: status === 'approved' ? 123 : null,
    productionUrl: status === 'succeeded' ? 'https://app.example.workers.dev' : null,
    errorCode: null,
    errorMessage: null,
    buildArtifactKey: null,
    buildArtifactGeneration: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('deployment handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findConnection.mockResolvedValue({ id: 'connection-1', status: 'active', generation: 1 });
    mocks.requireDeployment.mockRejectedValue(new Error('not configured'));
    mocks.createDeployment.mockResolvedValue(deployment());
    mocks.adoptExecutionGeneration.mockImplementation(async ({ deployment: current }) => current);
    mocks.executeUserOwnedDeployment.mockResolvedValue(deployment('succeeded'));
  });

  it('stores only an opaque reference to the exact user-owned backup', async () => {
    mocks.requireDeployment.mockRejectedValueOnce(
      new (await import('~/lib/.server/cloudflare/deployment-repository')).DeploymentNotFoundError(),
    );
    const db = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({ first: vi.fn(async () => ({ id: 'chat-row-1' })) })),
      })),
    } as unknown as D1Database;
    const result = await createOrReplayDeploymentPlanForUser({
      env: { DB: db } as Env,
      userId: 'user-1',
      chatId: 'chat-1',
      deploymentId: 'deployment-1',
      projectId: 'agent-1',
      revision,
      workspaceRevision: 7,
      project,
    });
    expect(result).toMatchObject({ id: 'deployment-1' });
    expect(mocks.createDeployment).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotKey: `workspace-runtime:agent-1:7:${revision}` }),
    );
  });

  it('executes approved deployment work in the user-owned runtime', async () => {
    const approved = deployment('approved');
    mocks.requireDeployment.mockResolvedValue(approved);
    const env = { DB: {} } as Env;
    const response = await userRuntimeDeploymentAction({
      request: new Request('https://ghostbuild.dev/api/deployments/deployment-1/execute', { method: 'POST' }),
      env,
      deploymentId: 'deployment-1',
      operation: 'execute',
      userId: 'user-1',
    });
    expect(response.status).toBe(200);
    expect(mocks.executeUserOwnedDeployment).toHaveBeenCalledWith({
      env,
      deploymentId: 'deployment-1',
      userId: 'user-1',
      connectionId: 'connection-1',
      executionGeneration: 1,
    });
  });

  it('does not accept a legacy snapshot argument', async () => {
    await expect(
      createOrReplayDeploymentPlanForUser({
        env: {} as Env,
        userId: 'user-1',
        chatId: 'chat-1',
        deploymentId: 'deployment-1',
        snapshot: new Blob(['zip']),
      }),
    ).rejects.toThrow('Browser-uploaded deployment snapshots are no longer supported.');
  });
});
