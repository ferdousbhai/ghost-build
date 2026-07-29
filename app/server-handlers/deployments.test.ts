import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveIdentity: vi.fn(),
  findConnection: vi.fn(),
  buildPlan: vi.fn(),
  createDeployment: vi.fn(),
  prepareRetry: vi.fn(),
  approveDeployment: vi.fn(),
  adoptLegacyExecutionGeneration: vi.fn(),
  requireDeployment: vi.fn(),
  putObjectAtKey: vi.fn(),
  deleteObject: vi.fn(),
  queueObjectGcCandidate: vi.fn(),
  cancelObjectGcCandidate: vi.fn(),
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
vi.mock('~/lib/.server/cloudflare/deployment-plan', async (importOriginal) => ({
  ...(await importOriginal()),
  buildDeploymentPlan: mocks.buildPlan,
}));
vi.mock('~/lib/.server/cloudflare/deployment-repository', async (importOriginal) => ({
  ...(await importOriginal()),
  createDeployment: mocks.createDeployment,
  prepareDeploymentRetry: mocks.prepareRetry,
  approveDeployment: mocks.approveDeployment,
  adoptLegacyApprovedDeploymentExecutionGeneration: mocks.adoptLegacyExecutionGeneration,
  requireDeploymentForUser: mocks.requireDeployment,
  listExpiredDeploymentSnapshots: mocks.listExpiredSnapshots,
  clearDeploymentSnapshot: mocks.clearSnapshot,
  claimOldestReplaceableDeploymentSnapshot: mocks.claimOldestReplaceableSnapshot,
  claimDeploymentSnapshotForRelease: mocks.claimSnapshotForRelease,
}));
vi.mock('~/lib/cloudflare/data/object-storage.server', () => ({
  putObjectAtKey: mocks.putObjectAtKey,
  deleteObject: mocks.deleteObject,
}));
vi.mock('~/lib/cloudflare/data/object-gc.server', async (importOriginal) => ({
  ...(await importOriginal()),
  queueObjectGcCandidate: mocks.queueObjectGcCandidate,
  cancelObjectGcCandidate: mocks.cancelObjectGcCandidate,
}));

import { DeploymentSnapshotLimitError } from '~/lib/.server/cloudflare/deployment-repository';
import {
  APP_AGENT_SECURITY_BOUNDARY_SHA256,
  DEPLOYMENT_SECURITY_BASELINE_VERSION,
  TEMPLATE_SOURCE_SHA256,
} from '~/lib/.server/cloudflare/deployment-security-baseline';
import { createDeploymentPlanAction, createOrReplayDeploymentPlanForUser, deploymentAction } from './deployments';

const plan = {
  version: 2 as const,
  deploymentId: 'deployment-1',
  sourceSha256: 'b'.repeat(64),
  templateSourceSha256: TEMPLATE_SOURCE_SHA256,
  securityBaselineVersion: DEPLOYMENT_SECURITY_BASELINE_VERSION,
  securityBoundarySha256: APP_AGENT_SECURITY_BOUNDARY_SHA256,
  project: {
    type: 'web_app' as const,
    bindings: { ai: true, d1: true, r2: true, appAgent: true },
  },
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
    {
      type: 'r2' as const,
      logicalName: 'APP_STORAGE',
      proposedName: 'ghostbuild-deployment-1-storage',
    },
    { type: 'durable_object' as const, logicalName: 'AppAgent', proposedName: 'AppAgent' },
    { type: 'workers_ai' as const, logicalName: 'AI', proposedName: 'AI' },
  ],
};

type TestWorkflowStatus =
  'queued' | 'running' | 'paused' | 'errored' | 'terminated' | 'complete' | 'waiting' | 'waitingForPause' | 'unknown';

type TestWorkflowInstance = {
  id: string;
  statusValue: TestWorkflowStatus;
  status: ReturnType<typeof vi.fn>;
  restart: ReturnType<typeof vi.fn>;
};

type TestEnv = Env & {
  DeploymentWorkflow: {
    createBatch: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
  };
  retainedWorkflowInstances: Map<string, TestWorkflowInstance>;
};

function env(): TestEnv {
  const retainedWorkflowInstances = new Map<string, TestWorkflowInstance>();
  const createBatch = vi.fn(async (batch: Array<{ id: string; params: unknown }>) => {
    const created: TestWorkflowInstance[] = [];
    for (const item of batch) {
      if (retainedWorkflowInstances.has(item.id)) {
        continue;
      }
      const instance: TestWorkflowInstance = {
        id: item.id,
        statusValue: 'queued',
        status: vi.fn(async () => ({ status: instance.statusValue })),
        restart: vi.fn(async () => {
          instance.statusValue = 'queued';
        }),
      };
      retainedWorkflowInstances.set(item.id, instance);
      created.push(instance);
    }
    return created;
  });
  const get = vi.fn(async (id: string) => {
    const instance = retainedWorkflowInstances.get(id);
    if (!instance) {
      throw new Error(`Unknown Workflow instance: ${id}`);
    }
    return instance;
  });
  return {
    DB: {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({ first: vi.fn(async () => ({ id: 'chat-primary' })) })),
      })),
    },
    DeploymentWorkflow: { createBatch, get },
    retainedWorkflowInstances,
  } as unknown as TestEnv;
}

function deployment(status = 'awaiting_approval') {
  return {
    id: 'deployment-1',
    chatId: 'chat-primary',
    userId: 'user-1',
    connectionId: 'connection-1',
    connectionGeneration: 1,
    executionGeneration: status === 'awaiting_approval' ? 0 : 1,
    buildArtifactKey: null,
    buildArtifactGeneration: null,
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
    mocks.queueObjectGcCandidate.mockImplementation(async (_db, storageKey) => ({ storageKey, notBefore: 123 }));
    mocks.cancelObjectGcCandidate.mockResolvedValue(true);
    mocks.putObjectAtKey.mockResolvedValue(undefined);
    mocks.createDeployment.mockResolvedValue(deployment());
    mocks.prepareRetry.mockResolvedValue(deployment());
    mocks.approveDeployment.mockResolvedValue(deployment('approved'));
    mocks.requireDeployment.mockResolvedValue(deployment());
    mocks.adoptLegacyExecutionGeneration.mockImplementation(async ({ deployment: current }) => current);
  });

  it('requires Cloudflare authentication', async () => {
    mocks.resolveIdentity.mockResolvedValue(null);
    const response = await createDeploymentPlanAction({ request: createRequest(), env: env() });
    expect(response.status).toBe(401);
    expect(mocks.putObjectAtKey).not.toHaveBeenCalled();
  });

  it('requires an active user Cloudflare connection', async () => {
    mocks.findConnection.mockResolvedValue(null);
    const response = await createDeploymentPlanAction({ request: createRequest(), env: env() });
    expect(response.status).toBe(409);
    expect(mocks.putObjectAtKey).not.toHaveBeenCalled();
  });

  it('stores an immutable snapshot and returns a reviewable plan', async () => {
    const response = await createDeploymentPlanAction({ request: createRequest(), env: env() });
    expect(response.status).toBe(201);
    const deploymentId = mocks.buildPlan.mock.calls[0]?.[0].deploymentId as string;
    const snapshotKey = `deployment-snapshots/${deploymentId}`;
    expect(mocks.queueObjectGcCandidate).toHaveBeenCalledWith(expect.anything(), snapshotKey);
    expect(mocks.putObjectAtKey).toHaveBeenCalledWith(expect.anything(), snapshotKey, expect.any(Blob));
    expect(mocks.createDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        id: deploymentId,
        userId: 'user-1',
        connectionId: 'connection-1',
        snapshotKey,
      }),
    );
    expect(mocks.cancelObjectGcCandidate).toHaveBeenCalledWith(expect.anything(), {
      storageKey: snapshotKey,
      notBefore: 123,
    });
    expect(await response.json()).toMatchObject({
      deployment: { status: 'awaiting_approval', planDigest: 'a'.repeat(64) },
    });
  });

  it('replays a deterministic server deployment plan without replacing its snapshot', async () => {
    const existing = deployment();
    mocks.requireDeployment.mockResolvedValue(existing);

    await expect(
      createOrReplayDeploymentPlanForUser({
        env: env(),
        userId: 'user-1',
        chatId: 'chat-1',
        deploymentId: existing.id,
        snapshot: new Blob(['source']),
      }),
    ).resolves.toMatchObject({ id: existing.id, planDigest: existing.planDigest });
    expect(mocks.buildPlan).not.toHaveBeenCalled();
    expect(mocks.putObjectAtKey).not.toHaveBeenCalled();
    expect(mocks.createDeployment).not.toHaveBeenCalled();
  });

  it('leaves a durable reference-aware cleanup receipt when R2 commits but its acknowledgement is lost', async () => {
    const committedObjects = new Set<string>();
    mocks.putObjectAtKey.mockImplementationOnce(async (_env, key: string) => {
      committedObjects.add(key);
      throw new Error('R2 acknowledgement lost');
    });

    const response = await createDeploymentPlanAction({ request: createRequest(), env: env() });

    expect(response.status).toBe(500);
    const deploymentId = mocks.buildPlan.mock.calls[0]?.[0].deploymentId as string;
    const snapshotKey = `deployment-snapshots/${deploymentId}`;
    expect(committedObjects).toContain(snapshotKey);
    expect(mocks.queueObjectGcCandidate).toHaveBeenCalledWith(expect.anything(), snapshotKey);
    expect(mocks.queueObjectGcCandidate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.putObjectAtKey.mock.invocationCallOrder[0],
    );
    expect(mocks.createDeployment).not.toHaveBeenCalled();
    expect(mocks.cancelObjectGcCandidate).not.toHaveBeenCalled();
    expect(mocks.deleteObject).not.toHaveBeenCalledWith(expect.anything(), snapshotKey);
  });

  it('retains queued cleanup after a definitive D1 insert failure', async () => {
    mocks.createDeployment.mockRejectedValueOnce(new Error('D1 insert failed'));

    const response = await createDeploymentPlanAction({ request: createRequest(), env: env() });

    expect(response.status).toBe(500);
    expect(mocks.queueObjectGcCandidate).toHaveBeenCalledOnce();
    expect(mocks.cancelObjectGcCandidate).not.toHaveBeenCalled();
    expect(mocks.deleteObject).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/^deployment-snapshots\//),
    );
  });

  it('preserves the deployment snapshot quota conflict while leaving failed-insert cleanup queued', async () => {
    mocks.createDeployment.mockRejectedValueOnce(new DeploymentSnapshotLimitError());

    const response = await createDeploymentPlanAction({ request: createRequest(), env: env() });

    expect(response.status).toBe(409);
    expect(mocks.queueObjectGcCandidate).toHaveBeenCalledOnce();
    expect(mocks.cancelObjectGcCandidate).not.toHaveBeenCalled();
  });

  it('rejects a declared oversized multipart request before reading its body', async () => {
    const request = createRequest();
    request.headers.set('content-length', String(11 * 1024 * 1024 + 1));
    const getReader = vi.spyOn(request.body as ReadableStream<Uint8Array>, 'getReader');

    const response = await createDeploymentPlanAction({ request, env: env() });

    expect(response.status).toBe(413);
    expect(getReader).not.toHaveBeenCalled();
    expect(mocks.buildPlan).not.toHaveBeenCalled();
  });

  it('stops an undeclared multipart body that exceeds the total request limit', async () => {
    const response = await createDeploymentPlanAction({
      request: createRequest(11 * 1024 * 1024),
      env: env(),
    });

    expect(response.status).toBe(413);
    expect(mocks.buildPlan).not.toHaveBeenCalled();
  });

  it('preserves an exact 10 MiB deployment snapshot', async () => {
    const response = await createDeploymentPlanAction({
      request: createRequest(10 * 1024 * 1024),
      env: env(),
    });

    expect(response.status).toBe(201);
    expect(mocks.buildPlan).toHaveBeenCalledWith(
      expect.objectContaining({ snapshot: expect.objectContaining({ size: 10 * 1024 * 1024 }) }),
    );
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

  it.each(['approve', 'retry', 'execute'] as const)(
    'rejects a stale security baseline before %s mutates deployment state',
    async (operation) => {
      const testEnv = env();
      mocks.requireDeployment.mockResolvedValue({
        ...deployment(operation === 'execute' ? 'approved' : 'failed'),
        approvedAt: operation === 'execute' ? 123 : null,
        plan: { ...plan, version: 1 },
      });
      const response = await deploymentAction({
        request: new Request(`https://ghostbuild.dev/api/deployments/deployment-1/${operation}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body:
            operation === 'approve'
              ? JSON.stringify({
                  planDigest: 'a'.repeat(64),
                  confirmCloudflareBilling: true,
                  confirmWorkersPaidNotAutomatic: true,
                })
              : undefined,
        }),
        env: testEnv,
        deploymentId: 'deployment-1',
        operation,
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ code: 'deployment_plan_stale' });
      expect(mocks.approveDeployment).not.toHaveBeenCalled();
      expect(mocks.prepareRetry).not.toHaveBeenCalled();
      expect(testEnv.DeploymentWorkflow.createBatch).not.toHaveBeenCalled();
    },
  );

  it('adopts an approval created during the execution-generation migration rollout before starting Workflow work', async () => {
    const testEnv = env();
    const legacyApproval = {
      ...deployment('approved'),
      executionGeneration: 0,
      approvedAt: 123,
      approvedDigest: 'a'.repeat(64),
    };
    const adoptedApproval = { ...legacyApproval, executionGeneration: 1 };
    mocks.requireDeployment.mockResolvedValue(legacyApproval);
    mocks.adoptLegacyExecutionGeneration.mockResolvedValue(adoptedApproval);

    const response = await deploymentAction({
      request: new Request('https://ghostbuild.dev/api/deployments/deployment-1/execute', { method: 'POST' }),
      env: testEnv,
      deploymentId: 'deployment-1',
      operation: 'execute',
    });

    expect(response.status).toBe(202);
    expect(mocks.adoptLegacyExecutionGeneration).toHaveBeenCalledWith({
      db: testEnv.DB,
      deployment: legacyApproval,
    });
    expect(testEnv.DeploymentWorkflow.createBatch).toHaveBeenCalledWith([
      {
        id: 'deployment-1-1',
        params: {
          deploymentId: 'deployment-1',
          userId: 'user-1',
          connectionId: 'connection-1',
          executionGeneration: 1,
        },
      },
    ]);
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
        id: 'deployment-1-1',
        params: {
          deploymentId: 'deployment-1',
          userId: 'user-1',
          connectionId: 'connection-1',
          executionGeneration: 1,
        },
      },
    ];
    expect(testEnv.DeploymentWorkflow?.createBatch).toHaveBeenNthCalledWith(1, expectedBatch);
    expect(testEnv.DeploymentWorkflow?.createBatch).toHaveBeenNthCalledWith(2, expectedBatch);
    await expect(testEnv.DeploymentWorkflow.createBatch.mock.results[0].value).resolves.toMatchObject([
      { id: 'deployment-1-1' },
    ]);
    await expect(testEnv.DeploymentWorkflow.createBatch.mock.results[1].value).resolves.toEqual([]);
    const retainedInstance = testEnv.retainedWorkflowInstances.get('deployment-1-1');
    expect(testEnv.DeploymentWorkflow.get).toHaveBeenCalledWith('deployment-1-1');
    expect(retainedInstance?.restart).not.toHaveBeenCalled();
  });

  it.each(['errored', 'terminated'] as const)(
    'restarts a retained %s Workflow only while the same approved execution remains current',
    async (retainedStatus) => {
      const testEnv = env();
      const approved = { ...deployment('approved'), approvedAt: 123 };
      mocks.requireDeployment.mockResolvedValue(approved);
      const execute = () =>
        deploymentAction({
          request: new Request('https://ghostbuild.dev/api/deployments/deployment-1/execute', { method: 'POST' }),
          env: testEnv,
          deploymentId: 'deployment-1',
          operation: 'execute',
        });

      await expect(execute()).resolves.toMatchObject({ status: 202 });
      const retainedInstance = testEnv.retainedWorkflowInstances.get('deployment-1-1');
      expect(retainedInstance).toBeDefined();
      retainedInstance!.statusValue = retainedStatus;

      await expect(execute()).resolves.toMatchObject({ status: 202 });

      expect(mocks.requireDeployment).toHaveBeenCalledTimes(3);
      expect(retainedInstance?.restart).toHaveBeenCalledOnce();
      expect(retainedInstance?.statusValue).toBe('queued');
    },
  );

  it.each(['queued', 'running', 'paused', 'waiting', 'waitingForPause', 'complete'] as const)(
    'does not restart a retained %s Workflow',
    async (retainedStatus) => {
      const testEnv = env();
      mocks.requireDeployment.mockResolvedValue({ ...deployment('approved'), approvedAt: 123 });
      const execute = () =>
        deploymentAction({
          request: new Request('https://ghostbuild.dev/api/deployments/deployment-1/execute', { method: 'POST' }),
          env: testEnv,
          deploymentId: 'deployment-1',
          operation: 'execute',
        });

      await execute();
      const retainedInstance = testEnv.retainedWorkflowInstances.get('deployment-1-1');
      expect(retainedInstance).toBeDefined();
      retainedInstance!.statusValue = retainedStatus;

      await expect(execute()).resolves.toMatchObject({ status: 202 });

      expect(mocks.requireDeployment).toHaveBeenCalledTimes(2);
      expect(retainedInstance?.restart).not.toHaveBeenCalled();
    },
  );

  it('surfaces an unknown retained Workflow status for retry instead of returning a false success', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const testEnv = env();
    mocks.requireDeployment.mockResolvedValue({ ...deployment('approved'), approvedAt: 123 });
    const execute = () =>
      deploymentAction({
        request: new Request('https://ghostbuild.dev/api/deployments/deployment-1/execute', { method: 'POST' }),
        env: testEnv,
        deploymentId: 'deployment-1',
        operation: 'execute',
      });

    await execute();
    const retainedInstance = testEnv.retainedWorkflowInstances.get('deployment-1-1');
    expect(retainedInstance).toBeDefined();
    retainedInstance!.statusValue = 'unknown';

    await expect(execute()).resolves.toMatchObject({ status: 500 });

    expect(retainedInstance?.restart).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith('Deployment request failed', expect.any(Error));
    consoleError.mockRestore();
  });

  it('does not restart an errored retained Workflow after the deployment is reapproved', async () => {
    const testEnv = env();
    const approved = { ...deployment('approved'), approvedAt: 123 };
    const reapproved = { ...approved, executionGeneration: 2, approvedAt: 456 };
    mocks.requireDeployment
      .mockResolvedValueOnce(approved)
      .mockResolvedValueOnce(approved)
      .mockResolvedValueOnce(reapproved);
    const execute = () =>
      deploymentAction({
        request: new Request('https://ghostbuild.dev/api/deployments/deployment-1/execute', { method: 'POST' }),
        env: testEnv,
        deploymentId: 'deployment-1',
        operation: 'execute',
      });

    await execute();
    const retainedInstance = testEnv.retainedWorkflowInstances.get('deployment-1-1');
    expect(retainedInstance).toBeDefined();
    retainedInstance!.statusValue = 'errored';

    await expect(execute()).resolves.toMatchObject({ status: 202 });

    expect(retainedInstance?.restart).not.toHaveBeenCalled();
  });

  it('keeps concurrent retained Workflow recovery idempotent', async () => {
    const testEnv = env();
    mocks.requireDeployment.mockResolvedValue({ ...deployment('approved'), approvedAt: 123 });
    const execute = () =>
      deploymentAction({
        request: new Request('https://ghostbuild.dev/api/deployments/deployment-1/execute', { method: 'POST' }),
        env: testEnv,
        deploymentId: 'deployment-1',
        operation: 'execute',
      });

    await execute();
    const retainedInstance = testEnv.retainedWorkflowInstances.get('deployment-1-1');
    expect(retainedInstance).toBeDefined();
    retainedInstance!.statusValue = 'errored';
    retainedInstance!.restart.mockImplementationOnce(async () => {
      retainedInstance!.statusValue = 'running';
      throw new Error('Workflow was already restarted');
    });

    await expect(execute()).resolves.toMatchObject({ status: 202 });

    expect(retainedInstance?.restart).toHaveBeenCalledOnce();
    expect(retainedInstance?.status).toHaveBeenCalledTimes(2);
  });

  it('propagates a genuine retained Workflow restart failure', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const testEnv = env();
    mocks.requireDeployment.mockResolvedValue({ ...deployment('approved'), approvedAt: 123 });
    const execute = () =>
      deploymentAction({
        request: new Request('https://ghostbuild.dev/api/deployments/deployment-1/execute', { method: 'POST' }),
        env: testEnv,
        deploymentId: 'deployment-1',
        operation: 'execute',
      });

    await execute();
    const retainedInstance = testEnv.retainedWorkflowInstances.get('deployment-1-1');
    expect(retainedInstance).toBeDefined();
    retainedInstance!.statusValue = 'errored';
    retainedInstance!.restart.mockRejectedValueOnce(new Error('Workflow restart unavailable'));

    await expect(execute()).resolves.toMatchObject({ status: 500 });

    expect(retainedInstance?.restart).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith('Deployment request failed', expect.any(Error));
    consoleError.mockRestore();
  });

  it('propagates unrelated Workflow creation failures', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const testEnv = env();
    testEnv.DeploymentWorkflow.createBatch.mockRejectedValueOnce(new Error('Workflow service unavailable'));
    mocks.requireDeployment.mockResolvedValue({ ...deployment('approved'), approvedAt: 123 });

    const response = await deploymentAction({
      request: new Request('https://ghostbuild.dev/api/deployments/deployment-1/execute', { method: 'POST' }),
      env: testEnv,
      deploymentId: 'deployment-1',
      operation: 'execute',
    });

    expect(response.status).toBe(500);
    expect(consoleError).toHaveBeenCalledWith('Deployment request failed', expect.any(Error));
    consoleError.mockRestore();
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
      errorCode: 'cloudflare_cleanup_required',
      errorMessage: 'Retry this deployment to reconcile its approved plan.',
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

  it('delegates stale active retry decisions to the repository lease check', async () => {
    mocks.requireDeployment.mockResolvedValue(deployment('building'));
    const response = await deploymentAction({
      request: new Request('https://ghostbuild.dev/api/deployments/deployment-1/retry', { method: 'POST' }),
      env: env(),
      deploymentId: 'deployment-1',
      operation: 'retry',
    });

    expect(response.status).toBe(201);
    expect(mocks.prepareRetry).toHaveBeenCalledOnce();
    expect(mocks.prepareRetry).toHaveBeenCalledWith(expect.objectContaining({ executionGeneration: 1 }));
  });
});

function createRequest(snapshotBytes: string | number = 'snapshot') {
  const body = new FormData();
  body.append(
    'snapshot',
    new Blob([typeof snapshotBytes === 'number' ? new Uint8Array(snapshotBytes) : snapshotBytes]),
  );
  return new Request('https://ghostbuild.dev/api/deployments/plan?chatId=chat-1', { method: 'POST', body });
}
