import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  record: vi.fn(),
  requireDeployment: vi.fn(),
  transition: vi.fn(),
  requireConnection: vi.fn(),
  resolve: vi.fn(),
  createD1: vi.fn(),
  createR2: vi.fn(),
  getSubdomain: vi.fn(),
  build: vi.fn(),
  publish: vi.fn(),
}));

vi.mock('./deployment-repository', () => ({
  claimApprovedDeployment: mocks.claim,
  recordDeploymentResource: mocks.record,
  requireDeployment: mocks.requireDeployment,
  transitionDeployment: mocks.transition,
}));
vi.mock('./cloudflare-connection-repository', () => ({ requireActiveCloudflareConnection: mocks.requireConnection }));
vi.mock('./cloudflare-credential-vault', () => ({
  D1CloudflareCredentialVault: { fromEnv: () => ({ resolve: mocks.resolve }) },
}));
vi.mock('./user-account-api', () => ({
  UserCloudflareAccountApi: class {
    createD1ForPlan = mocks.createD1;
    createR2ForPlan = mocks.createR2;
    getWorkersSubdomain = mocks.getSubdomain;
  },
}));
vi.mock('./deployment-build-executor', () => ({ buildDeploymentSnapshot: mocks.build }));
vi.mock('./deployment-publish-executor', () => ({ publishDeploymentBuild: mocks.publish }));

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
    });
    mocks.resolve.mockResolvedValue('real-user-token');
    mocks.createD1.mockResolvedValue({ id: 'd1-id', name: 'ghostbuild-deployment-1' });
    mocks.createR2.mockResolvedValue({
      id: 'ghostbuild-deployment-1-storage',
      name: 'ghostbuild-deployment-1-storage',
    });
    mocks.getSubdomain.mockResolvedValue('user-subdomain');
    mocks.build.mockResolvedValue(new Uint8Array([1]));
    mocks.publish.mockResolvedValue(undefined);
    mocks.record.mockResolvedValue(undefined);
    mocks.transition.mockResolvedValue(undefined);
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
    expect(mocks.build.mock.invocationCallOrder[0]).toBeLessThan(mocks.createD1.mock.invocationCallOrder[0]);
    expect(mocks.createD1).toHaveBeenCalledOnce();
    expect(mocks.createR2).toHaveBeenCalledOnce();
    expect(mocks.build).toHaveBeenCalledWith(
      expect.objectContaining({ deploymentId: 'deployment-1', snapshotKey: 'snapshot-1' }),
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
    expect(mocks.createD1).not.toHaveBeenCalled();
    expect(mocks.createR2).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.transition).toHaveBeenLastCalledWith(
      expect.objectContaining({
        expectedStatus: 'building',
        nextStatus: 'failed',
        errorCode: 'isolated_build_failed',
      }),
    );
  });
});

function deployment(status: string) {
  return {
    id: 'deployment-1',
    chatId: 'chat-1',
    userId: 'user-1',
    connectionId: 'connection-1',
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
