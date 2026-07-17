import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveIdentity: vi.fn(),
  findConnection: vi.fn(),
  buildPlan: vi.fn(),
  createDeployment: vi.fn(),
  prepareRetry: vi.fn(),
  approveDeployment: vi.fn(),
  requireDeployment: vi.fn(),
  putObject: vi.fn(),
  deleteObject: vi.fn(),
  listExpiredSnapshots: vi.fn(),
  clearSnapshot: vi.fn(),
  claimOldestReplaceableSnapshot: vi.fn(),
  claimSnapshotForRelease: vi.fn(),
}));

vi.mock('~/lib/.server/agent-request-identity', () => ({
  resolveAgentRequestIdentity: mocks.resolveIdentity,
}));
vi.mock('~/lib/.server/cloudflare/cloudflare-connection-repository', () => ({
  findCloudflareConnectionForUser: mocks.findConnection,
}));
vi.mock('~/lib/.server/cloudflare/deployment-plan', () => ({
  buildDeploymentPlan: mocks.buildPlan,
}));
vi.mock('~/lib/.server/cloudflare/deployment-repository', async (importOriginal) => ({
  ...(await importOriginal()),
  createDeployment: mocks.createDeployment,
  prepareDeploymentRetry: mocks.prepareRetry,
  approveDeployment: mocks.approveDeployment,
  requireDeploymentForUser: mocks.requireDeployment,
  listExpiredDeploymentSnapshots: mocks.listExpiredSnapshots,
  clearDeploymentSnapshot: mocks.clearSnapshot,
  claimOldestReplaceableDeploymentSnapshot: mocks.claimOldestReplaceableSnapshot,
  claimDeploymentSnapshotForRelease: mocks.claimSnapshotForRelease,
}));
vi.mock('~/lib/cloudflare/data/object-storage.server', () => ({
  putObject: mocks.putObject,
  deleteObject: mocks.deleteObject,
}));

import { createDeploymentPlanAction, deploymentAction } from './deployments';

const plan = {
  version: 1 as const,
  deploymentId: 'deployment-1',
  sourceSha256: 'b'.repeat(64),
  billing: {
    infrastructure: 'user_cloudflare_account' as const,
    workersAi: 'user_cloudflare_account' as const,
    workersPaidUpgrade: 'explicit_user_authorization_required' as const,
  },
  resources: [],
};

function env() {
  return {
    DB: {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({ first: vi.fn(async () => ({ id: 'chat-primary' })) })),
      })),
    },
    DeploymentWorkflow: { createBatch: vi.fn(async () => []) },
  } as unknown as Env;
}

function deployment(status = 'awaiting_approval') {
  return {
    id: 'deployment-1',
    chatId: 'chat-primary',
    userId: 'user-1',
    connectionId: 'connection-1',
    connectionGeneration: 1,
    snapshotKey: 'deployment-snapshots/key',
    status,
    plan,
    planDigest: 'a'.repeat(64),
    approvedDigest: null,
    approvedAt: null,
    productionUrl: null,
    errorCode: null,
    errorMessage: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('deployment handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveIdentity.mockResolvedValue({ userId: 'user-1', ownerId: 'user-1' });
    mocks.findConnection.mockResolvedValue({ id: 'connection-1', status: 'active', generation: 1 });
    mocks.listExpiredSnapshots.mockResolvedValue([]);
    mocks.claimOldestReplaceableSnapshot.mockResolvedValue(null);
    mocks.claimSnapshotForRelease.mockImplementation(async (snapshot) => snapshot);
    mocks.buildPlan.mockResolvedValue({ plan, digest: 'a'.repeat(64) });
    mocks.putObject.mockResolvedValue('deployment-snapshots/key');
    mocks.createDeployment.mockResolvedValue(deployment());
    mocks.prepareRetry.mockResolvedValue(deployment());
    mocks.approveDeployment.mockResolvedValue(deployment('approved'));
  });

  it('requires Cloudflare authentication', async () => {
    mocks.resolveIdentity.mockResolvedValue(null);
    const response = await createDeploymentPlanAction({ request: createRequest(), env: env() });
    expect(response.status).toBe(401);
    expect(mocks.putObject).not.toHaveBeenCalled();
  });

  it('requires an active user Cloudflare connection', async () => {
    mocks.findConnection.mockResolvedValue(null);
    const response = await createDeploymentPlanAction({ request: createRequest(), env: env() });
    expect(response.status).toBe(409);
    expect(mocks.putObject).not.toHaveBeenCalled();
  });

  it('stores an immutable snapshot and returns a reviewable plan', async () => {
    const response = await createDeploymentPlanAction({ request: createRequest(), env: env() });
    expect(response.status).toBe(201);
    expect(mocks.putObject).toHaveBeenCalledWith(expect.anything(), 'deployment-snapshots', expect.any(Blob));
    expect(mocks.createDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        connectionId: 'connection-1',
        snapshotKey: 'deployment-snapshots/key',
      }),
    );
    expect(await response.json()).toMatchObject({
      deployment: { status: 'awaiting_approval', planDigest: 'a'.repeat(64) },
    });
  });

  it('supersedes the oldest retained failure so a corrected fourth plan is accepted', async () => {
    mocks.claimOldestReplaceableSnapshot.mockResolvedValue({
      deploymentId: 'failed-deployment-1',
      snapshotKey: 'deployment-snapshots/failed-1',
    });
    const response = await createDeploymentPlanAction({ request: createRequest(), env: env() });
    expect(response.status).toBe(201);
    expect(mocks.deleteObject).toHaveBeenCalledWith(expect.anything(), 'deployment-snapshots/failed-1');
    expect(mocks.clearSnapshot).toHaveBeenCalledWith(expect.objectContaining({ deploymentId: 'failed-deployment-1' }));
  });

  it('requires explicit billing and no-auto-upgrade confirmations when approving', async () => {
    const response = await deploymentAction({
      request: new Request('https://ghostbuild.dev/api/deployments/deployment-1/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ planDigest: 'a'.repeat(64), confirmCloudflareBilling: true }),
      }),
      env: env(),
      deploymentId: 'deployment-1',
      operation: 'approve',
    });
    expect(response.status).toBe(400);
    expect(mocks.approveDeployment).not.toHaveBeenCalled();
  });

  it('approves only the reviewed plan digest', async () => {
    const response = await deploymentAction({
      request: new Request('https://ghostbuild.dev/api/deployments/deployment-1/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          planDigest: 'a'.repeat(64),
          confirmCloudflareBilling: true,
          confirmWorkersPaidNotAutomatic: true,
        }),
      }),
      env: env(),
      deploymentId: 'deployment-1',
      operation: 'approve',
    });
    expect(response.status).toBe(200);
    expect(mocks.approveDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        deploymentId: 'deployment-1',
        userId: 'user-1',
        connectionId: 'connection-1',
        approvedDigest: 'a'.repeat(64),
      }),
    );
  });

  it('deduplicates repeated execution requests within one approved Workflow attempt', async () => {
    const testEnv = env();
    mocks.requireDeployment.mockResolvedValue({ ...deployment('approved'), approvedAt: 123 });
    const execute = () =>
      deploymentAction({
        request: new Request('https://ghostbuild.dev/api/deployments/deployment-1/execute', { method: 'POST' }),
        env: testEnv,
        deploymentId: 'deployment-1',
        operation: 'execute',
      });
    await expect(execute()).resolves.toMatchObject({ status: 202 });
    await expect(execute()).resolves.toMatchObject({ status: 202 });
    const expectedBatch = [
      {
        id: 'deployment-1-123',
        params: { deploymentId: 'deployment-1', userId: 'user-1', connectionId: 'connection-1' },
      },
    ];
    expect(testEnv.DeploymentWorkflow?.createBatch).toHaveBeenNthCalledWith(1, expectedBatch);
    expect(testEnv.DeploymentWorkflow?.createBatch).toHaveBeenNthCalledWith(2, expectedBatch);
  });

  it('invalidates approval when reconnecting to a different Cloudflare account', async () => {
    const testEnv = env();
    mocks.requireDeployment.mockResolvedValue({ ...deployment('approved'), approvedAt: 123 });
    mocks.findConnection.mockResolvedValue({
      id: 'connection-1',
      accountId: 'account-2',
      status: 'active',
      generation: 2,
    });
    const response = await deploymentAction({
      request: new Request('https://ghostbuild.dev/api/deployments/deployment-1/execute', { method: 'POST' }),
      env: testEnv,
      deploymentId: 'deployment-1',
      operation: 'execute',
    });
    expect(response.status).toBe(409);
    expect(testEnv.DeploymentWorkflow?.createBatch).not.toHaveBeenCalled();
  });

  it('reuses the immutable plan and resource names after a failed deployment', async () => {
    mocks.requireDeployment.mockResolvedValue({
      ...deployment('failed'),
      errorCode: 'isolated_build_failed',
      errorMessage: 'Build failed.',
    });
    const response = await deploymentAction({
      request: new Request('https://ghostbuild.dev/api/deployments/deployment-1/retry', { method: 'POST' }),
      env: env(),
      deploymentId: 'deployment-1',
      operation: 'retry',
    });

    expect(response.status).toBe(201);
    expect(mocks.prepareRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        deploymentId: 'deployment-1',
        userId: 'user-1',
        connectionId: 'connection-1',
      }),
    );
    expect(mocks.createDeployment).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ deployment: { status: 'awaiting_approval' } });
  });
});

function createRequest() {
  const body = new FormData();
  body.append('snapshot', new Blob(['snapshot']));
  return new Request('https://ghostbuild.dev/api/deployments/plan?chatId=chat-1', { method: 'POST', body });
}
