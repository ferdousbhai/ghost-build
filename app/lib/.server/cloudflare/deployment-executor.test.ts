import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Deployment } from './deployment-repository';

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  record: vi.fn(),
  requireDeployment: vi.fn(),
  transition: vi.fn(),
  requireConnection: vi.fn(),
  resolve: vi.fn(),
  ensureD1: vi.fn(),
  ensureR2: vi.fn(),
  getSubdomain: vi.fn(),
  build: vi.fn(),
  publish: vi.fn(),
  clearSnapshot: vi.fn(),
  deleteObject: vi.fn(),
}));

vi.mock('./deployment-repository', () => ({
  DeploymentConcurrencyLimitError: class DeploymentConcurrencyLimitError extends Error {},
  claimApprovedDeployment: mocks.claim,
  recordDeploymentResource: mocks.record,
  requireDeployment: mocks.requireDeployment,
  transitionDeployment: mocks.transition,
  clearDeploymentSnapshot: mocks.clearSnapshot,
}));
vi.mock('~/lib/cloudflare/data/object-storage.server', () => ({ deleteObject: mocks.deleteObject }));
vi.mock('./cloudflare-connection-repository', () => ({ requireActiveCloudflareConnection: mocks.requireConnection }));
vi.mock('./cloudflare-credential-vault', () => ({
  D1CloudflareCredentialVault: { fromEnv: () => ({ resolve: mocks.resolve }) },
}));
vi.mock('./user-account-api', () => ({
  UserCloudflareAccountApi: class {
    ensureD1ForPlan = mocks.ensureD1;
    ensureR2ForPlan = mocks.ensureR2;
    getWorkersSubdomain = mocks.getSubdomain;
  },
}));
vi.mock('./deployment-build-executor', () => ({ buildDeploymentSnapshot: mocks.build }));
vi.mock('./deployment-publish-executor', () => ({ publishDeploymentBuild: mocks.publish }));

import { DeploymentConcurrencyLimitError } from './deployment-repository';
import { executeApprovedDeployment } from './deployment-executor';

describe('executeApprovedDeployment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const deploying = deployment('deploying');
    mocks.claim.mockResolvedValue(deployment('provisioning'));
    mocks.requireDeployment.mockResolvedValueOnce(deploying).mockResolvedValueOnce({
      ...deploying,
      status: 'succeeded',
      productionUrl: 'https://ghostbuild-deployment-1.user-subdomain.workers.dev',
    });
    mocks.requireConnection.mockResolvedValue({
      id: 'connection-1',
      userId: 'user-1',
      accountId: 'account-1',
      credentialHandle: 'credential-1',
      status: 'active',
      generation: 1,
    });
    mocks.resolve.mockResolvedValue('real-user-token');
    mocks.ensureD1.mockResolvedValue({ id: 'd1-id', name: 'ghostbuild-deployment-1' });
    mocks.ensureR2.mockResolvedValue({
      id: 'ghostbuild-deployment-1-storage',
      name: 'ghostbuild-deployment-1-storage',
    });
    mocks.getSubdomain.mockResolvedValue('user-subdomain');
    mocks.build.mockResolvedValue(new Uint8Array([1]));
    mocks.publish.mockResolvedValue(undefined);
    mocks.record.mockResolvedValue(undefined);
    mocks.transition.mockResolvedValue(undefined);
    mocks.clearSnapshot.mockResolvedValue(true);
    mocks.deleteObject.mockResolvedValue(undefined);
  });

  test('moves an approved digest through user-account provisioning, isolated build, and publish', async () => {
    const result = await executeApprovedDeployment({
      env: {
        DB: {},
        CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY: 'configured',
      } as unknown as Env,
      deploymentId: 'deployment-1',
      userId: 'user-1',
      connectionId: 'connection-1',
    });

    expect(mocks.claim).toHaveBeenCalledWith(
      expect.objectContaining({ deploymentId: 'deployment-1', userId: 'user-1', connectionId: 'connection-1' }),
    );
    expect(mocks.build.mock.invocationCallOrder[0]).toBeLessThan(mocks.ensureD1.mock.invocationCallOrder[0]);
    expect(mocks.ensureD1).toHaveBeenCalledOnce();
    expect(mocks.ensureR2).toHaveBeenCalledOnce();
    expect(mocks.build).toHaveBeenCalledWith(
      expect.objectContaining({
        deploymentId: 'deployment-1',
        snapshotKey: 'snapshot-1',
        expectedSourceSha256: 'a'.repeat(64),
      }),
    );
    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({ d1DatabaseId: 'd1-id', r2BucketName: 'ghostbuild-deployment-1-storage' }),
    );
    expect(mocks.transition.mock.calls.map((call) => [call[0].expectedStatus, call[0].nextStatus])).toEqual([
      ['provisioning', 'building'],
      ['building', 'provisioning'],
      ['provisioning', 'deploying'],
      ['deploying', 'succeeded'],
    ]);
    expect(result.status).toBe('succeeded');
  });

  test('persists the failed phase without silently retrying or changing Cloudflare billing', async () => {
    mocks.build.mockRejectedValue(new Error('build failed'));
    await expect(
      executeApprovedDeployment({
        env: { DB: {}, CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY: 'configured' } as unknown as Env,
        deploymentId: 'deployment-1',
        userId: 'user-1',
        connectionId: 'connection-1',
      }),
    ).rejects.toThrow('build failed');
    expect(mocks.ensureD1).not.toHaveBeenCalled();
    expect(mocks.ensureR2).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.transition).toHaveBeenLastCalledWith(
      expect.objectContaining({
        expectedStatus: 'building',
        nextStatus: 'failed',
        errorCode: 'isolated_build_failed',
      }),
    );
  });

  test('does not provision unused storage for a Worker-only deployment', async () => {
    const worker = deployment('provisioning');
    worker.plan.project = {
      type: 'worker',
      bindings: { ai: false, d1: false, r2: false, appAgent: false },
    };
    worker.plan.resources = worker.plan.resources.filter((resource) => resource.type === 'worker');
    mocks.claim.mockResolvedValue(worker);
    mocks.requireDeployment
      .mockReset()
      .mockResolvedValueOnce({ ...worker, status: 'deploying' })
      .mockResolvedValueOnce({
        ...worker,
        status: 'succeeded',
        productionUrl: 'https://ghostbuild-deployment-1.user-subdomain.workers.dev',
      });
    await executeApprovedDeployment({
      env: { DB: {}, CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY: 'configured' } as unknown as Env,
      deploymentId: 'deployment-1',
      userId: 'user-1',
      connectionId: 'connection-1',
    });
    expect(mocks.ensureD1).not.toHaveBeenCalled();
    expect(mocks.ensureR2).not.toHaveBeenCalled();
    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({ d1DatabaseId: undefined, r2BucketName: undefined }),
    );
  });

  test('persists a retryable failure when another deployment owns the user concurrency slot', async () => {
    mocks.claim.mockRejectedValue(new DeploymentConcurrencyLimitError());
    await expect(
      executeApprovedDeployment({
        env: { DB: {} } as Env,
        deploymentId: 'deployment-1',
        userId: 'user-1',
        connectionId: 'connection-1',
      }),
    ).rejects.toBeInstanceOf(DeploymentConcurrencyLimitError);
    expect(mocks.transition).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedStatus: 'approved',
        nextStatus: 'failed',
        errorCode: 'deployment_concurrency_limited',
      }),
    );
  });
});

function deployment(status: Deployment['status']): Deployment {
  return {
    id: 'deployment-1',
    chatId: 'chat-1',
    userId: 'user-1',
    connectionId: 'connection-1',
    connectionGeneration: 1,
    snapshotKey: 'snapshot-1',
    status,
    plan: {
      version: 1,
      deploymentId: 'deployment-1',
      sourceSha256: 'a'.repeat(64),
      billing: {
        infrastructure: 'user_cloudflare_account',
        workersAi: 'user_cloudflare_account',
        workersPaidUpgrade: 'explicit_user_authorization_required',
      },
      resources: [
        { type: 'worker', logicalName: 'app', proposedName: 'ghostbuild-deployment-1' },
        { type: 'd1', logicalName: 'DB', proposedName: 'ghostbuild-deployment-1' },
        { type: 'r2', logicalName: 'APP_STORAGE', proposedName: 'ghostbuild-deployment-1-storage' },
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
