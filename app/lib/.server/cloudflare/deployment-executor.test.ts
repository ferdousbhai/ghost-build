import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { DeploymentBuildReceipt } from './deployment-build-artifact';
import type { Deployment } from './deployment-repository';

const receipt: DeploymentBuildReceipt = {
  version: 2,
  deploymentId: 'deployment-1',
  executionGeneration: 1,
  planDigest: 'a'.repeat(64),
  sourceSha256: 'a'.repeat(64),
  objectKey: 'build-key',
  buildSha256: 'b'.repeat(64),
  byteLength: 1,
  receiptSha256: 'c'.repeat(64),
};

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  record: vi.fn(),
  requireDeployment: vi.fn(),
  retainBuildReference: vi.fn(),
  transition: vi.fn(),
  requireConnection: vi.fn(),
  resolve: vi.fn(),
  ensureD1: vi.fn(),
  ensureR2: vi.fn(),
  getSubdomain: vi.fn(),
  readActiveWorker: vi.fn(),
  recordAttestation: vi.fn(),
  recordSecurityIntent: vi.fn(),
  build: vi.fn(),
  storeBuild: vi.fn(),
  readStoredBuild: vi.fn(),
  loadBuild: vi.fn(),
  buildKey: vi.fn(),
  publish: vi.fn(),
  clearSnapshot: vi.fn(),
  deleteObject: vi.fn(),
}));

vi.mock('./deployment-repository', () => ({
  DeploymentConcurrencyLimitError: class DeploymentConcurrencyLimitError extends Error {},
  claimApprovedDeployment: mocks.claim,
  recordDeploymentResource: mocks.record,
  requireDeployment: mocks.requireDeployment,
  retainDeploymentBuildArtifactReference: mocks.retainBuildReference,
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
    readActiveWorkerDeployment = mocks.readActiveWorker;
  },
}));
vi.mock('./deployment-security-inventory', () => ({
  attestManagedDeploymentSecurity: mocks.recordAttestation,
  recordManagedDeploymentSecurityIntent: mocks.recordSecurityIntent,
}));
vi.mock('./deployment-build-executor', () => ({ buildDeploymentSnapshot: mocks.build }));
vi.mock('./deployment-build-artifact', () => ({
  DeploymentBuildArtifactError: class DeploymentBuildArtifactError extends Error {},
  storeDeploymentBuildArtifact: mocks.storeBuild,
  readStoredDeploymentBuildReceipt: mocks.readStoredBuild,
  loadDeploymentBuildArtifact: mocks.loadBuild,
  deploymentBuildArtifactKey: mocks.buildKey,
}));
vi.mock('./deployment-publish-executor', () => ({ publishDeploymentBuild: mocks.publish }));

import { DeploymentConcurrencyLimitError } from './deployment-repository';
import { DeploymentBuildArtifactError } from './deployment-build-artifact';
import { buildApprovedDeploymentArtifact, publishApprovedDeploymentArtifact } from './deployment-executor';
import {
  APP_AGENT_SECURITY_BOUNDARY_SHA256,
  DEPLOYMENT_SECURITY_BASELINE_VERSION,
  TEMPLATE_SOURCE_SHA256,
} from './deployment-security-baseline';

describe('two-step approved deployment execution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireDeployment.mockReset();
    const approved = deployment('approved');
    const provisioning = deployment('provisioning');
    const deploying = deployment('deploying');
    mocks.claim.mockResolvedValue(provisioning);
    mocks.requireDeployment
      .mockResolvedValueOnce(approved)
      .mockResolvedValueOnce(provisioning)
      .mockResolvedValueOnce(deploying)
      .mockResolvedValueOnce({
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
    mocks.ensureD1.mockImplementation(async (_plan: unknown, logicalName?: string) =>
      logicalName === 'AGENT_SECURITY_DB'
        ? { id: 'agent-security-d1-id', name: 'ghostbuild-deployment-1-agent-security' }
        : { id: 'd1-id', name: 'ghostbuild-deployment-1' },
    );
    mocks.ensureR2.mockResolvedValue({
      id: 'ghostbuild-deployment-1-storage',
      name: 'ghostbuild-deployment-1-storage',
    });
    mocks.getSubdomain.mockResolvedValue('user-subdomain');
    mocks.readActiveWorker.mockResolvedValue({
      providerDeploymentId: 'provider-deployment-1',
      workerVersionId: 'worker-version-1',
      bindings: [],
      crons: [],
    });
    mocks.recordAttestation.mockResolvedValue({ status: 'current' });
    mocks.recordSecurityIntent.mockResolvedValue(undefined);
    mocks.build.mockResolvedValue(new Uint8Array([1]));
    mocks.storeBuild.mockResolvedValue(receipt);
    mocks.readStoredBuild.mockResolvedValue(null);
    mocks.loadBuild.mockResolvedValue(new Uint8Array([1]));
    mocks.buildKey.mockReturnValue('build-key');
    mocks.publish.mockResolvedValue({ workerVersionId: 'worker-version-1' });
    mocks.record.mockResolvedValue(undefined);
    mocks.transition.mockResolvedValue(undefined);
    mocks.retainBuildReference.mockResolvedValue(undefined);
    mocks.clearSnapshot.mockResolvedValue(true);
    mocks.deleteObject.mockResolvedValue(undefined);
  });

  test('persists and verifies the build before any user-account provisioning', async () => {
    const result = await executeBoth();

    expect(mocks.claim).toHaveBeenCalledWith(
      expect.objectContaining({ deploymentId: 'deployment-1', userId: 'user-1', connectionId: 'connection-1' }),
    );
    expect(mocks.retainBuildReference).toHaveBeenCalledWith(
      expect.objectContaining({ deploymentId: 'deployment-1', executionGeneration: 1, objectKey: 'build-key' }),
    );
    expect(mocks.retainBuildReference.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.readStoredBuild.mock.invocationCallOrder[0],
    );
    expect(mocks.build).toHaveBeenCalledWith(
      expect.objectContaining({
        project: {
          type: 'web_app',
          bindings: { ai: true, d1: true, r2: true, appAgent: true },
        },
      }),
    );
    expect(mocks.build.mock.invocationCallOrder[0]).toBeLessThan(mocks.ensureD1.mock.invocationCallOrder[0]);
    expect(mocks.storeBuild.mock.invocationCallOrder[0]).toBeLessThan(mocks.ensureD1.mock.invocationCallOrder[0]);
    expect(mocks.loadBuild.mock.invocationCallOrder[0]).toBeLessThan(mocks.ensureD1.mock.invocationCallOrder[0]);
    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        d1DatabaseId: 'd1-id',
        agentSecurityD1DatabaseId: 'agent-security-d1-id',
        r2BucketName: 'ghostbuild-deployment-1-storage',
      }),
    );
    expect(mocks.ensureD1).toHaveBeenNthCalledWith(1, expect.anything());
    expect(mocks.ensureD1).toHaveBeenNthCalledWith(2, expect.anything(), 'AGENT_SECURITY_DB');
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceType: 'd1',
        logicalName: 'AGENT_SECURITY_DB',
        providerResourceId: 'agent-security-d1-id',
      }),
    );
    expect(mocks.recordAttestation).toHaveBeenCalledWith(
      expect.objectContaining({
        workerName: 'ghostbuild-deployment-1',
        accountId: 'account-1',
        accountApi: expect.anything(),
        expectedPublishedVersionId: 'worker-version-1',
        expectedAgentSecurityD1DatabaseId: 'agent-security-d1-id',
      }),
    );
    expect(mocks.recordSecurityIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        workerName: 'ghostbuild-deployment-1',
        accountId: 'account-1',
      }),
    );
    expect(mocks.recordSecurityIntent.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.publish.mock.invocationCallOrder[0],
    );
    expect(mocks.recordAttestation.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.transition.mock.invocationCallOrder.at(-1)!,
    );
    expect(mocks.transition.mock.calls.map((call) => [call[0].expectedStatus, call[0].nextStatus])).toEqual([
      ['provisioning', 'building'],
      ['building', 'provisioning'],
      ['provisioning', 'deploying'],
      ['deploying', 'succeeded'],
    ]);
    expect(mocks.deleteObject).toHaveBeenCalledWith(expect.anything(), 'build-key');
    expect(mocks.deleteObject).toHaveBeenCalledWith(expect.anything(), 'snapshot-1');
    expect(result.status).toBe('succeeded');
  });

  test('fails the build step before any billable provider mutation', async () => {
    mocks.build.mockRejectedValue(new Error('build failed'));

    await expect(buildApprovedDeploymentArtifact(executionArgs())).rejects.toThrow('build failed');

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

  test('leaves approval restartable when the connection lookup fails before claim', async () => {
    mocks.requireConnection.mockRejectedValue(new Error('temporary D1 failure'));

    await expect(buildApprovedDeploymentArtifact(executionArgs())).rejects.toThrow('temporary D1 failure');

    expect(mocks.requireDeployment).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.transition).not.toHaveBeenCalled();
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.storeBuild).not.toHaveBeenCalled();
    expect(mocks.retainBuildReference).not.toHaveBeenCalled();
  });

  test('rejects a stale Workflow generation before reading or mutating its reapproved deployment', async () => {
    mocks.requireDeployment.mockReset().mockResolvedValue(deployment('building', 2));

    await expect(buildApprovedDeploymentArtifact(executionArgs(1))).rejects.toThrow(
      'execution identity no longer matches',
    );

    expect(mocks.readStoredBuild).not.toHaveBeenCalled();
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.storeBuild).not.toHaveBeenCalled();
    expect(mocks.transition).not.toHaveBeenCalled();
    expect(mocks.deleteObject).not.toHaveBeenCalled();
    expect(mocks.retainBuildReference).not.toHaveBeenCalled();
  });

  test('reuses a verified deterministic artifact when step one restarts after its status checkpoint', async () => {
    mocks.requireDeployment.mockReset().mockResolvedValue(deployment('provisioning'));
    mocks.readStoredBuild.mockResolvedValue(receipt);

    await expect(buildApprovedDeploymentArtifact(executionArgs())).resolves.toEqual(receipt);

    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.storeBuild).not.toHaveBeenCalled();
    expect(mocks.transition).not.toHaveBeenCalled();
    expect(mocks.retainBuildReference).toHaveBeenCalledOnce();
  });

  test('closes a lost build-to-provisioning checkpoint from a verified stored artifact', async () => {
    mocks.requireDeployment.mockReset().mockResolvedValue(deployment('building'));
    mocks.readStoredBuild.mockResolvedValue(receipt);

    await expect(buildApprovedDeploymentArtifact(executionArgs())).resolves.toEqual(receipt);

    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.transition).toHaveBeenCalledWith(
      expect.objectContaining({ expectedStatus: 'building', nextStatus: 'provisioning' }),
    );
  });

  test('safely rebuilds from a persisted building state when no artifact was committed', async () => {
    mocks.requireDeployment.mockReset().mockResolvedValue(deployment('building'));

    await expect(buildApprovedDeploymentArtifact(executionArgs())).resolves.toEqual(receipt);

    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.build).toHaveBeenCalledOnce();
    expect(mocks.transition.mock.calls.map((call) => [call[0].expectedStatus, call[0].nextStatus])).toEqual([
      ['building', 'provisioning'],
    ]);
  });

  test('fails and cleans up an untrusted immutable artifact instead of overwriting it', async () => {
    mocks.requireDeployment.mockReset().mockResolvedValue(deployment('building'));
    mocks.readStoredBuild.mockRejectedValue(new DeploymentBuildArtifactError('receipt mismatch'));
    mocks.storeBuild.mockRejectedValue(new Error('immutable artifact already exists'));

    await expect(buildApprovedDeploymentArtifact(executionArgs())).rejects.toThrow('immutable artifact already exists');

    expect(mocks.build).toHaveBeenCalledOnce();
    expect(mocks.storeBuild).toHaveBeenCalledOnce();
    expect(mocks.transition).toHaveBeenCalledWith(
      expect.objectContaining({ expectedStatus: 'building', nextStatus: 'failed' }),
    );
    expect(mocks.deleteObject).toHaveBeenCalledWith(expect.anything(), 'build-key');
  });

  test('retains a valid artifact when another checkpoint wins the status transition', async () => {
    mocks.requireDeployment.mockReset().mockResolvedValue(deployment('building'));
    mocks.transition.mockRejectedValue(new Error('status conflict'));

    await expect(buildApprovedDeploymentArtifact(executionArgs())).rejects.toThrow('status conflict');

    expect(mocks.storeBuild).toHaveBeenCalledOnce();
    expect(mocks.deleteObject).not.toHaveBeenCalled();
  });

  test('cleans up an artifact it wrote only after recording the attempt as failed', async () => {
    mocks.requireDeployment.mockReset().mockResolvedValue(deployment('building'));
    mocks.transition.mockRejectedValueOnce(new Error('checkpoint failed')).mockResolvedValueOnce(undefined);

    await expect(buildApprovedDeploymentArtifact(executionArgs())).rejects.toThrow('checkpoint failed');

    expect(mocks.transition).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedStatus: 'building', nextStatus: 'failed' }),
    );
    expect(mocks.deleteObject).toHaveBeenCalledWith(expect.anything(), 'build-key');
  });

  test('cleans up a committed artifact after its store acknowledgement is lost and failure is persisted', async () => {
    mocks.requireDeployment.mockReset().mockResolvedValue(deployment('building'));
    mocks.storeBuild.mockRejectedValue(new Error('R2 acknowledgement lost after commit'));

    await expect(buildApprovedDeploymentArtifact(executionArgs())).rejects.toThrow(
      'R2 acknowledgement lost after commit',
    );

    expect(mocks.transition).toHaveBeenCalledWith(
      expect.objectContaining({ expectedStatus: 'building', nextStatus: 'failed' }),
    );
    expect(mocks.transition.mock.invocationCallOrder.at(-1)).toBeLessThan(
      mocks.deleteObject.mock.invocationCallOrder[0],
    );
    expect(mocks.deleteObject).toHaveBeenCalledWith(expect.anything(), 'build-key');
  });

  test('rejects an invalid durable build receipt before provider mutation and cleans its deterministic key', async () => {
    mocks.loadBuild.mockRejectedValue(new Error('receipt mismatch'));
    mocks.requireDeployment.mockReset().mockResolvedValue(deployment('provisioning'));

    await expect(publishApprovedDeploymentArtifact({ ...executionArgs(), receipt })).rejects.toThrow(
      'receipt mismatch',
    );

    expect(mocks.ensureD1).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.transition).toHaveBeenLastCalledWith(
      expect.objectContaining({
        expectedStatus: 'provisioning',
        nextStatus: 'failed',
        errorCode: 'deployment_build_artifact_invalid',
      }),
    );
    expect(mocks.deleteObject).toHaveBeenCalledWith(expect.anything(), 'build-key');
  });

  test('persists cleanup-required state when provisioning may have changed the provider', async () => {
    mocks.ensureD1.mockRejectedValue(new Error('Cloudflare response lost after create'));

    await expect(executeBoth()).rejects.toThrow('Cloudflare response lost after create');

    expect(mocks.transition).toHaveBeenLastCalledWith(
      expect.objectContaining({
        expectedStatus: 'provisioning',
        nextStatus: 'failed',
        errorCode: 'cloudflare_cleanup_required',
        errorMessage: expect.stringContaining('Retry this deployment to reconcile its approved plan.'),
      }),
    );
  });

  test('does not delete a live artifact when terminal persistence fails', async () => {
    mocks.ensureD1.mockRejectedValue(new Error('Cloudflare response lost after create'));
    mocks.transition.mockImplementation(async (args) => {
      if (args.nextStatus === 'failed') {
        throw new Error('D1 terminal checkpoint unavailable');
      }
    });

    await expect(executeBoth()).rejects.toThrow('Cloudflare response lost after create');

    expect(mocks.deleteObject).not.toHaveBeenCalledWith(expect.anything(), 'build-key');
  });

  test('persists cleanup-required state when publish may have deployed the Worker', async () => {
    mocks.publish.mockRejectedValue(new Error('Cloudflare response lost after deploy'));

    await expect(executeBoth()).rejects.toThrow('Cloudflare response lost after deploy');

    expect(mocks.transition).toHaveBeenLastCalledWith(
      expect.objectContaining({
        expectedStatus: 'deploying',
        nextStatus: 'failed',
        errorCode: 'cloudflare_cleanup_required',
      }),
    );
    expect(mocks.recordSecurityIntent).toHaveBeenCalledOnce();
    expect(mocks.recordSecurityIntent.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.publish.mock.invocationCallOrder[0],
    );
    expect(mocks.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ resourceType: 'worker', logicalName: 'app' }),
    );
  });

  test('fails closed when the published Worker cannot be attested', async () => {
    mocks.recordAttestation.mockRejectedValue(new Error('Published Worker is unavailable for security attestation.'));

    await expect(executeBoth()).rejects.toThrow('unavailable for security attestation');

    expect(mocks.recordAttestation).toHaveBeenCalledOnce();
    expect(mocks.recordSecurityIntent).toHaveBeenCalledOnce();
    expect(mocks.recordSecurityIntent.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.recordAttestation.mock.invocationCallOrder[0],
    );
    expect(mocks.transition).toHaveBeenLastCalledWith(
      expect.objectContaining({
        expectedStatus: 'deploying',
        nextStatus: 'failed',
        errorCode: 'cloudflare_cleanup_required',
      }),
    );
  });

  test('reconciles a restart after the deploying checkpoint with deterministic provider and Worker names', async () => {
    const deploying = deployment('deploying');
    mocks.requireDeployment
      .mockReset()
      .mockResolvedValueOnce(deploying)
      .mockResolvedValueOnce(deploying)
      .mockResolvedValueOnce({ ...deploying, status: 'succeeded' });

    const result = await publishApprovedDeploymentArtifact({ ...executionArgs(), receipt });

    expect(mocks.publish).toHaveBeenCalledOnce();
    expect(mocks.transition.mock.calls.map((call) => [call[0].expectedStatus, call[0].nextStatus])).toEqual([
      ['deploying', 'succeeded'],
    ]);
    expect(result.status).toBe('succeeded');
  });

  test('returns an already-succeeded deployment without replaying provider effects after a lost step checkpoint', async () => {
    const succeeded = { ...deployment('succeeded'), productionUrl: 'https://existing.example.com' };
    mocks.requireDeployment.mockReset().mockResolvedValue(succeeded);

    await expect(publishApprovedDeploymentArtifact({ ...executionArgs(), receipt })).resolves.toEqual(succeeded);

    expect(mocks.loadBuild).not.toHaveBeenCalled();
    expect(mocks.ensureD1).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.deleteObject).toHaveBeenCalledWith(expect.anything(), 'build-key');
    expect(mocks.deleteObject).toHaveBeenCalledWith(expect.anything(), 'snapshot-1');
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
      .mockResolvedValueOnce(worker)
      .mockResolvedValueOnce(worker)
      .mockResolvedValueOnce({ ...worker, status: 'deploying' })
      .mockResolvedValueOnce({ ...worker, status: 'succeeded' });

    await executeBoth();

    expect(mocks.ensureD1).not.toHaveBeenCalled();
    expect(mocks.ensureR2).not.toHaveBeenCalled();
    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({ d1DatabaseId: undefined, r2BucketName: undefined }),
    );
  });

  test('persists a retryable failure when another deployment owns the user concurrency slot', async () => {
    mocks.claim.mockRejectedValue(new DeploymentConcurrencyLimitError());

    await expect(buildApprovedDeploymentArtifact(executionArgs())).rejects.toBeInstanceOf(
      DeploymentConcurrencyLimitError,
    );
    expect(mocks.transition).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedStatus: 'approved',
        nextStatus: 'failed',
        errorCode: 'deployment_concurrency_limited',
      }),
    );
  });
});

async function executeBoth(): Promise<Deployment> {
  const args = executionArgs();
  const buildReceipt = await buildApprovedDeploymentArtifact(args);
  return publishApprovedDeploymentArtifact({ ...args, receipt: buildReceipt });
}

function executionArgs(executionGeneration = 1) {
  return {
    env: {
      DB: {},
      APP_STORAGE: {},
      CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY: 'configured',
    } as unknown as Env,
    deploymentId: 'deployment-1',
    userId: 'user-1',
    connectionId: 'connection-1',
    executionGeneration,
  };
}

function deployment(status: Deployment['status'], executionGeneration = 1): Deployment {
  return {
    id: 'deployment-1',
    chatId: 'chat-1',
    userId: 'user-1',
    connectionId: 'connection-1',
    connectionGeneration: 1,
    executionGeneration,
    buildArtifactKey: status === 'approved' ? null : 'build-key',
    buildArtifactGeneration: status === 'approved' ? null : executionGeneration,
    snapshotKey: 'snapshot-1',
    status,
    plan: {
      version: 2,
      deploymentId: 'deployment-1',
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
