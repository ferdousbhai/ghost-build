import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudflareConnection } from './cloudflare-connection-repository';
import type { UserWorkspaceRuntime } from './user-workspace-runtime-repository';

const mocks = vi.hoisted(() => ({
  requireActiveConnection: vi.fn(),
  claim: vi.fn(),
  markError: vi.fn(),
  markReady: vi.fn(),
  deriveSecret: vi.fn(),
  waitForReadiness: vi.fn(),
  resolveCredential: vi.fn(),
  accountApi: {
    readWorkspaceContainersEntitlement: vi.fn(),
    getWorkersSubdomain: vi.fn(),
    ensureD1Database: vi.fn(),
    applyD1Migrations: vi.fn(),
    deployWorkspaceRuntimeWorker: vi.fn(),
    ensureWorkspaceRuntimeContainer: vi.fn(),
    configureWorkspaceRuntimeGcSchedule: vi.fn(),
    enableWorkerSubdomain: vi.fn(),
  },
}));

vi.mock('./cloudflare-connection-repository', () => ({
  requireActiveCloudflareConnection: mocks.requireActiveConnection,
}));
vi.mock('./cloudflare-credential-vault', () => ({
  D1CloudflareCredentialVault: class {
    static fromEnv() {
      return { resolve: mocks.resolveCredential };
    }
  },
}));
vi.mock('./user-workspace-runtime-repository', () => ({
  claimUserWorkspaceRuntimeProvisioning: mocks.claim,
  markUserWorkspaceRuntimeError: mocks.markError,
  markUserWorkspaceRuntimeReady: mocks.markReady,
}));
vi.mock('./user-workspace-runtime-secret', () => ({ deriveUserWorkspaceRuntimeSecret: mocks.deriveSecret }));
vi.mock('./user-workspace-runtime-readiness', () => ({
  waitForUserWorkspaceRuntimeReadiness: mocks.waitForReadiness,
}));
vi.mock('./user-account-api', () => ({
  UserCloudflareAccountApi: class {
    constructor() {
      return mocks.accountApi;
    }
  },
}));

import {
  provisionUserWorkspaceRuntime,
  UserWorkspaceContainersEligibilityUnknownError,
  UserWorkspaceContainersPlanRequiredError,
  USER_WORKSPACE_REQUIRED_CAPABILITIES,
} from './user-workspace-runtime-provisioner';

const connection: CloudflareConnection = {
  id: 'connection-1',
  userId: 'user-1',
  accountId: 'account-1',
  accountName: 'Account',
  status: 'active',
  credentialHandle: 'handle-1',
  grantedScopes: [...USER_WORKSPACE_REQUIRED_CAPABILITIES],
  aiBillingEnabled: true,
  connectedAt: 1,
  updatedAt: 1,
  generation: 3,
};

const runtime: UserWorkspaceRuntime = {
  userId: 'user-1',
  connectionId: 'connection-1',
  connectionGeneration: 3,
  workerName: 'ghostbuild-workspace-1',
  endpoint: 'https://ghostbuild-workspace-1.user.workers.dev',
  runtimeVersion: 'a'.repeat(64),
  status: 'provisioning',
  lastError: null,
  provisioningAttemptId: 'attempt-1',
  provisioningLeaseExpiresAt: 2,
  createdAt: 1,
  updatedAt: 1,
};

function provision() {
  return provisionUserWorkspaceRuntime({
    env: { DB: {}, CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY: 'k'.repeat(44) } as unknown as Env,
    userId: 'user-1',
    connectionId: 'connection-1',
  });
}

describe('provisionUserWorkspaceRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireActiveConnection.mockResolvedValue(connection);
    mocks.resolveCredential.mockResolvedValue('user-token');
    mocks.deriveSecret.mockResolvedValue('s'.repeat(64));
    mocks.claim.mockResolvedValue({ runtime, claimed: true });
    mocks.markError.mockResolvedValue(runtime);
    mocks.markReady.mockResolvedValue({ ...runtime, status: 'ready' });
    mocks.accountApi.getWorkersSubdomain.mockResolvedValue('user');
    mocks.accountApi.ensureD1Database.mockResolvedValue({ id: 'database-1', name: 'ghostbuild-data-1' });
    mocks.accountApi.deployWorkspaceRuntimeWorker.mockResolvedValue({
      workerVersionId: 'version-1',
      namespaceId: 'namespace-1',
    });
  });

  it('creates nothing in an account whose plan excludes Cloudflare Containers', async () => {
    mocks.accountApi.readWorkspaceContainersEntitlement.mockResolvedValue({
      status: 'plan_required',
      message: 'You do not have access to Cloudflare Containers. Deploying containers requires the Workers Paid plan.',
      upgradeUrl: 'https://dash.cloudflare.com/?to=/:account/workers/plans',
    });

    const error = await provision().catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(UserWorkspaceContainersPlanRequiredError);
    expect((error as UserWorkspaceContainersPlanRequiredError).upgradeUrl).toBe(
      'https://dash.cloudflare.com/?to=/:account/workers/plans',
    );
    expect(mocks.accountApi.ensureD1Database).not.toHaveBeenCalled();
    expect(mocks.accountApi.deployWorkspaceRuntimeWorker).not.toHaveBeenCalled();
    // The operator report reads this row, so an ineligible plan has to stay visible as a reason.
    expect(mocks.markError).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('Workers Paid plan') }),
    );
  });

  it('refuses to guess when the Containers entitlement cannot be determined', async () => {
    mocks.accountApi.readWorkspaceContainersEntitlement.mockResolvedValue({
      status: 'undetermined',
      reason: 'Cloudflare did not answer the Containers capability check: The connection was reset.',
    });

    await expect(provision()).rejects.toBeInstanceOf(UserWorkspaceContainersEligibilityUnknownError);
    expect(mocks.accountApi.ensureD1Database).not.toHaveBeenCalled();
    expect(mocks.markError).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('could not confirm') }),
    );
  });

  it('provisions the workspace once the account is entitled to Containers', async () => {
    mocks.accountApi.readWorkspaceContainersEntitlement.mockResolvedValue({ status: 'entitled' });

    await expect(provision()).resolves.toEqual(expect.objectContaining({ status: 'ready' }));
    expect(mocks.accountApi.ensureWorkspaceRuntimeContainer).toHaveBeenCalledOnce();
    expect(mocks.markError).not.toHaveBeenCalled();
  });
});
