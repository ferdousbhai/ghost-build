import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  attestManagedDeploymentSecurity: vi.fn(),
  claimApprovedDeployment: vi.fn(),
  recordDeploymentResource: vi.fn(),
  requireDeployment: vi.fn(),
  transitionDeployment: vi.fn(),
  accountApi: {
    ensureD1ForPlan: vi.fn(),
    ensureR2ForPlan: vi.fn(),
    applyD1Migrations: vi.fn(),
    deployManagedWorker: vi.fn(),
    configureManagedWorkerSchedule: vi.fn(),
    enableWorkerSubdomain: vi.fn(),
    getWorkersSubdomain: vi.fn(),
    readActiveWorkerDeployment: vi.fn(),
  },
  UserCloudflareAccountApi: vi.fn(),
}));

vi.mock('./deployment-plan', () => ({
  deploymentPlanResourceName: (plan: { resources: Array<Record<string, string>> }, type: string, logicalName: string) =>
    plan.resources.find((resource) => resource.type === type && resource.logicalName === logicalName)?.proposedName ??
    null,
  deploymentProjectProfile: (plan: { project: unknown }) => plan.project,
  isCurrentDeploymentPlan: () => true,
}));
vi.mock('./deployment-repository', () => ({
  claimApprovedDeployment: mocks.claimApprovedDeployment,
  recordDeploymentResource: mocks.recordDeploymentResource,
  requireDeployment: mocks.requireDeployment,
  transitionDeployment: mocks.transitionDeployment,
}));
vi.mock('./deployment-security-inventory', () => ({
  attestManagedDeploymentSecurity: mocks.attestManagedDeploymentSecurity,
}));
vi.mock('./user-account-api', () => ({
  UserCloudflareAccountApi: mocks.UserCloudflareAccountApi,
}));

import { executeUserOwnedDeployment } from './user-workspace-deployment-executor';

describe('executeUserOwnedDeployment credential-free Computer flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Vitest must expose a constructible implementation because production
    // instantiates the account API with `new`.
    // eslint-disable-next-line prefer-arrow-callback
    mocks.UserCloudflareAccountApi.mockImplementation(function () {
      return mocks.accountApi;
    });
    mocks.accountApi.deployManagedWorker.mockResolvedValue({
      workerVersionId: '11111111-1111-4111-8111-111111111111',
    });
    mocks.accountApi.configureManagedWorkerSchedule.mockResolvedValue(undefined);
    mocks.accountApi.enableWorkerSubdomain.mockResolvedValue(undefined);
    mocks.accountApi.getWorkersSubdomain.mockResolvedValue('user-subdomain');
    mocks.attestManagedDeploymentSecurity.mockResolvedValue({ status: 'current' });
    mocks.recordDeploymentResource.mockResolvedValue(undefined);
    mocks.transitionDeployment.mockResolvedValue(undefined);
  });

  it('passes no credential to ProjectWorkspace and publishes only through the trusted account API', async () => {
    const revision = 'a'.repeat(64);
    const plan = {
      version: 2,
      deploymentId: 'deployment-1',
      sourceSha256: revision,
      templateSourceSha256: 'b'.repeat(64),
      securityBaselineVersion: 24,
      securityBoundarySha256: 'c'.repeat(64),
      project: {
        type: 'worker',
        bindings: { ai: false, d1: false, r2: false, appAgent: false },
      },
      billing: {
        infrastructure: 'user_cloudflare_account',
        workersAi: 'user_cloudflare_account',
        workersPaidUpgrade: 'explicit_user_authorization_required',
      },
      resources: [{ type: 'worker', logicalName: 'app', proposedName: 'ghostbuild-deployment-1' }],
    };
    const deployment = {
      id: 'deployment-1',
      chatId: 'chat-1',
      userId: 'user-1',
      connectionId: 'connection-1',
      connectionGeneration: 3,
      executionGeneration: 4,
      workspaceReference: `workspace-runtime:project-1:7:${revision}`,
      status: 'approved',
      plan,
      planDigest: 'digest-1',
      approvedDigest: 'digest-1',
      approvedAt: 1,
      productionUrl: null,
      errorCode: null,
      errorMessage: null,
      createdAt: 1,
      updatedAt: 1,
    };
    const moduleBytes = new TextEncoder().encode('export default {}');
    const moduleDigest = await crypto.subtle.digest('SHA-256', moduleBytes);
    const prepareDeploymentArtifact = vi.fn(async (_input: Record<string, unknown>) => ({
      revision,
      mainModule: 'server.js',
      modules: [
        {
          path: 'server.js',
          bytes: moduleBytes,
          size: moduleBytes.byteLength,
          sha256: [...new Uint8Array(moduleDigest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
        },
      ],
      assets: [],
      migrations: { DB: [], AGENT_SECURITY_DB: [] },
    }));
    const beginDeploymentSession = vi.fn().mockResolvedValue({ sessionId: 'deployment-1:4' });
    const assertDeploymentSession = vi.fn().mockResolvedValue({ workspaceRevision: 7, revision });
    const finishDeploymentSession = vi.fn().mockResolvedValue({ status: 'completed' });
    const projectNamespace = {
      idFromName: vi.fn((name: string) => `id:${name}`),
      get: vi.fn(() => ({
        beginDeploymentSession,
        assertDeploymentSession,
        prepareDeploymentArtifact,
        finishDeploymentSession,
      })),
    };
    mocks.requireDeployment
      .mockResolvedValueOnce(deployment)
      .mockResolvedValueOnce({ ...deployment, status: 'deploying' })
      .mockResolvedValueOnce({ ...deployment, status: 'succeeded' });
    mocks.claimApprovedDeployment.mockResolvedValue({ ...deployment, status: 'provisioning' });
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ accessToken: 'provisioning-oauth-token' }, { headers: { 'Cache-Control': 'no-store' } }),
      )
      .mockResolvedValueOnce(
        Response.json({ accessToken: 'publishing-oauth-token' }, { headers: { 'Cache-Control': 'no-store' } }),
      );

    await executeUserOwnedDeployment({
      env: {
        DB: {} as D1Database,
        GHOSTBUILD_USER_RUNTIME: '1',
        GHOSTBUILD_CONTROL_PLANE_ENDPOINT: 'https://ghostbuild.dev',
        CONTROL_PLANE_SECRET: 'runtime-secret-that-is-long-enough',
        CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
        GHOSTBUILD_USER_ID: 'user-1',
        GHOSTBUILD_CONNECTION_ID: 'connection-1',
        GHOSTBUILD_CONNECTION_GENERATION: '3',
        PROJECT_WORKSPACE: projectNamespace,
      } as unknown as Env,
      deploymentId: 'deployment-1',
      userId: 'user-1',
      connectionId: 'connection-1',
      executionGeneration: 4,
      request,
    });

    expect(prepareDeploymentArtifact).toHaveBeenCalledOnce();
    const projectInput = prepareDeploymentArtifact.mock.calls[0]?.[0];
    expect(projectInput).toMatchObject({
      revision,
      workerName: 'ghostbuild-deployment-1',
      projectType: 'worker',
      sessionId: 'deployment-1:4',
    });
    expect(JSON.stringify(projectInput)).not.toMatch(/oauth|token|secret|authorization/i);
    expect(mocks.accountApi.deployManagedWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceSha256: revision,
        mainModule: 'server.js',
        modules: expect.any(Array),
      }),
    );
    expect(mocks.attestManagedDeploymentSecurity).toHaveBeenCalledWith(
      expect.objectContaining({ expectedPublishedVersionId: '11111111-1111-4111-8111-111111111111' }),
    );
    expect(request).toHaveBeenCalledTimes(2);
    expect(
      request.mock.calls.every(([url]) => url === 'https://ghostbuild.dev/api/cloudflare/runtime-credential'),
    ).toBe(true);
    expect(JSON.parse(String(request.mock.calls[1]?.[1]?.body))).toMatchObject({ forceRefresh: true });
    expect(beginDeploymentSession).toHaveBeenCalledWith({
      operationId: 'deployment-1:4',
      expectedWorkspaceRevision: 7,
      expectedSnapshotRevision: revision,
    });
    expect(assertDeploymentSession).toHaveBeenCalledWith({ sessionId: 'deployment-1:4' });
    expect(finishDeploymentSession).toHaveBeenCalledWith({
      sessionId: 'deployment-1:4',
      status: 'completed',
    });
    expect(assertDeploymentSession.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.accountApi.deployManagedWorker.mock.invocationCallOrder[0]!,
    );
  });
});
