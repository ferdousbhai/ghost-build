import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Deployment } from './deployment-repository';

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  readActive: vi.fn(),
}));

vi.mock('./cloudflare-credential-vault', () => ({
  D1CloudflareCredentialVault: { fromEnv: () => ({ resolve: mocks.resolve }) },
}));
vi.mock('./user-account-api', () => ({
  CloudflareAccountApiError: class CloudflareAccountApiError extends Error {},
  UserCloudflareAccountApi: class {
    readActiveWorkerDeployment = mocks.readActive;
  },
}));

import {
  attestManagedDeploymentSecurity,
  DeploymentSecurityAttestationError,
  evaluateDeploymentSecurityAttestation,
  recordManagedDeploymentSecurityIntent,
  recordManagedDeploymentSecurityAttestation,
  refreshDeploymentSecurityInventoryBestEffort,
} from './deployment-security-inventory';
import {
  APP_AGENT_SECURITY_BOUNDARY_SHA256,
  DEPLOYMENT_SECURITY_BASELINE_VERSION,
  TEMPLATE_SOURCE_SHA256,
} from './deployment-security-baseline';

const templateSourceSha256 = TEMPLATE_SOURCE_SHA256;
const securityBoundarySha256 = APP_AGENT_SECURITY_BOUNDARY_SHA256;

describe('deployment security inventory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolve.mockResolvedValue('token');
  });

  test('accepts only an active version with exact trusted metadata and the cleanup trigger', () => {
    expect(
      evaluateDeploymentSecurityAttestation({
        readback: readback(),
        expectedTemplateSourceSha256: templateSourceSha256,
        expectedSecurityBaselineVersion: DEPLOYMENT_SECURITY_BASELINE_VERSION,
        expectedSecurityBoundarySha256: securityBoundarySha256,
        expectedAgentSecurityD1DatabaseId: 'agent-security-d1-id',
        requiresAgentCleanup: true,
      }),
    ).toMatchObject({
      status: 'current',
      observedTemplateSourceSha256: templateSourceSha256,
      observedSecurityBaselineVersion: DEPLOYMENT_SECURITY_BASELINE_VERSION,
      workerVersionId: 'worker-version-1',
    });
  });

  test('persists a pending managed target without claiming provider existence or attestation', async () => {
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const bind = vi.fn((..._values: unknown[]) => ({ run }));

    await recordManagedDeploymentSecurityIntent({
      db: { prepare: vi.fn(() => ({ bind })) } as unknown as D1Database,
      deployment: deployment(),
      workerName: 'ghostbuild-deployment-1',
      accountId: 'account-1',
      now: 100,
    });

    expect(bind.mock.calls[0]).toEqual([
      'connection-1',
      'ghostbuild-deployment-1',
      'user-1',
      'account-1',
      'deployment-1',
      1,
      'legacy_candidate',
      templateSourceSha256,
      DEPLOYMENT_SECURITY_BASELINE_VERSION,
      securityBoundarySha256,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      0,
      100,
      100,
    ]);
    expect(run).toHaveBeenCalledOnce();
  });

  test('treats self-asserted baseline vars without version metadata and cleanup as drift', () => {
    const value = readback();
    value.bindings = value.bindings.filter((binding) => binding.type !== 'version_metadata');
    value.crons = [];

    expect(
      evaluateDeploymentSecurityAttestation({
        readback: value,
        expectedTemplateSourceSha256: templateSourceSha256,
        expectedSecurityBaselineVersion: DEPLOYMENT_SECURITY_BASELINE_VERSION,
        expectedSecurityBoundarySha256: securityBoundarySha256,
        expectedAgentSecurityD1DatabaseId: 'agent-security-d1-id',
        requiresAgentCleanup: true,
      }).status,
    ).toBe('drifted');
  });

  test('treats an added unreviewed schedule as drift', () => {
    const value = readback();
    value.crons.push('*/5 * * * *');

    expect(
      evaluateDeploymentSecurityAttestation({
        readback: value,
        expectedTemplateSourceSha256: templateSourceSha256,
        expectedSecurityBaselineVersion: DEPLOYMENT_SECURITY_BASELINE_VERSION,
        expectedSecurityBoundarySha256: securityBoundarySha256,
        expectedAgentSecurityD1DatabaseId: 'agent-security-d1-id',
        requiresAgentCleanup: true,
      }).status,
    ).toBe('drifted');
  });

  test('rejects a missing or wrong protected security database binding', () => {
    const missing = readback();
    missing.bindings = missing.bindings.filter((binding) => binding.name !== 'AGENT_SECURITY_DB');
    const wrong = readback();
    const binding = wrong.bindings.find((candidate) => candidate.name === 'AGENT_SECURITY_DB');
    if (binding) {
      binding.database_id = 'wrong-d1-id';
    }
    const evaluate = (value: ReturnType<typeof readback>) =>
      evaluateDeploymentSecurityAttestation({
        readback: value,
        expectedTemplateSourceSha256: templateSourceSha256,
        expectedSecurityBaselineVersion: DEPLOYMENT_SECURITY_BASELINE_VERSION,
        expectedSecurityBoundarySha256: securityBoundarySha256,
        expectedAgentSecurityD1DatabaseId: 'agent-security-d1-id',
        requiresAgentCleanup: true,
      }).status;

    expect(evaluate(missing)).toBe('drifted');
    expect(evaluate(wrong)).toBe('drifted');
  });

  test('rejects a managed AppAgent attestation whose recorded security D1 resource is missing', () => {
    expect(
      evaluateDeploymentSecurityAttestation({
        readback: readback(),
        expectedTemplateSourceSha256: templateSourceSha256,
        expectedSecurityBaselineVersion: DEPLOYMENT_SECURITY_BASELINE_VERSION,
        expectedSecurityBoundarySha256: securityBoundarySha256,
        requireExpectedAgentSecurityD1Identity: true,
        requiresAgentCleanup: true,
      }).status,
    ).toBe('drifted');
  });

  test('persists provider version identity before accepting a managed deployment', async () => {
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const bind = vi.fn((..._values: unknown[]) => ({ run }));
    const db = { prepare: vi.fn(() => ({ bind })) } as unknown as D1Database;

    await expect(
      recordManagedDeploymentSecurityAttestation({
        db,
        deployment: deployment(),
        workerName: 'ghostbuild-deployment-1',
        accountId: 'account-1',
        readback: readback(),
        now: 100,
      }),
    ).resolves.toMatchObject({ status: 'current', workerVersionId: 'worker-version-1' });

    expect(bind.mock.calls[0]).toEqual([
      'connection-1',
      'ghostbuild-deployment-1',
      'user-1',
      'account-1',
      'deployment-1',
      1,
      'current',
      templateSourceSha256,
      DEPLOYMENT_SECURITY_BASELINE_VERSION,
      securityBoundarySha256,
      templateSourceSha256,
      DEPLOYMENT_SECURITY_BASELINE_VERSION,
      securityBoundarySha256,
      'provider-deployment-1',
      'worker-version-1',
      'etag-1',
      'worker-version-1',
      'etag-1',
      null,
      100,
      100,
      100,
      100,
    ]);

    const drift = readback();
    drift.crons = [];
    await expect(
      recordManagedDeploymentSecurityAttestation({
        db,
        deployment: deployment(),
        workerName: 'ghostbuild-deployment-1',
        accountId: 'account-1',
        readback: drift,
      }),
    ).rejects.toBeInstanceOf(DeploymentSecurityAttestationError);
    expect(run).toHaveBeenCalledTimes(2);
  });

  test('polls until the exact published Worker version is active before pinning it', async () => {
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const bind = vi.fn((..._values: unknown[]) => ({ run }));
    const previous = { ...readback(), workerVersionId: 'previous-version', scriptEtag: 'previous-etag' };
    const published = { ...readback(), workerVersionId: 'published-version', scriptEtag: 'published-etag' };
    const readActiveWorkerDeployment = vi.fn().mockResolvedValueOnce(previous).mockResolvedValueOnce(published);
    const retryDelay = vi.fn(async () => undefined);

    await expect(
      attestManagedDeploymentSecurity({
        db: { prepare: vi.fn(() => ({ bind })) } as unknown as D1Database,
        deployment: deployment(),
        workerName: 'ghostbuild-deployment-1',
        accountId: 'account-1',
        accountApi: { readActiveWorkerDeployment },
        expectedPublishedVersionId: 'published-version',
        expectedAgentSecurityD1DatabaseId: 'agent-security-d1-id',
        attempts: 2,
        retryDelay,
      }),
    ).resolves.toMatchObject({ status: 'current', workerVersionId: 'published-version' });

    expect(readActiveWorkerDeployment).toHaveBeenCalledTimes(2);
    expect(retryDelay).toHaveBeenCalledOnce();
    expect(bind.mock.calls[0]?.[14]).toBe('published-version');
    expect(bind.mock.calls[0]?.[15]).toBe('published-etag');
  });

  test('records an old active version only as observed state when publish convergence fails', async () => {
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const bind = vi.fn((..._values: unknown[]) => ({ run }));
    const previous = { ...readback(), workerVersionId: 'previous-version', scriptEtag: 'previous-etag' };

    await expect(
      attestManagedDeploymentSecurity({
        db: { prepare: vi.fn(() => ({ bind })) } as unknown as D1Database,
        deployment: deployment(),
        workerName: 'ghostbuild-deployment-1',
        accountId: 'account-1',
        accountApi: { readActiveWorkerDeployment: vi.fn(async () => previous) },
        expectedPublishedVersionId: 'published-version',
        expectedAgentSecurityD1DatabaseId: 'agent-security-d1-id',
        attempts: 2,
        retryDelay: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(DeploymentSecurityAttestationError);

    expect(bind.mock.calls[0]?.[6]).toBe('drifted');
    expect(bind.mock.calls[0]?.[14]).toBeNull();
    expect(bind.mock.calls[0]?.[15]).toBeNull();
    expect(bind.mock.calls[0]?.[16]).toBe('previous-version');
    expect(bind.mock.calls[0]?.[17]).toBe('previous-etag');
    expect(bind.mock.calls[0]?.[19]).toBeNull();
  });

  test('does not let a later self-asserted version replace immutable attested pins', async () => {
    const target = {
      id: 'connection-1',
      user_id: 'user-1',
      account_id: 'account-1',
      credential_handle: 'credential-1',
      worker_name: 'ghostbuild-deployment-1',
      managed_deployment_id: 'deployment-1',
      expected_template_source_sha256: templateSourceSha256,
      expected_security_baseline_version: DEPLOYMENT_SECURITY_BASELINE_VERSION,
      expected_security_boundary_sha256: securityBoundarySha256,
      expected_agent_security_d1_id: 'agent-security-d1-id',
      requires_agent_cleanup: 1,
      attested_worker_version_id: 'worker-version-1',
      attested_script_etag: 'etag-1',
    };
    const insertRun = vi.fn(async () => ({ meta: { changes: 1 } }));
    const insertBind = vi.fn((..._values: unknown[]) => ({ run: insertRun }));
    const prepare = vi.fn((query: string) => {
      if (!query.trimStart().startsWith('SELECT')) {
        return { bind: insertBind };
      }
      return query.includes('? AS worker_name')
        ? { bind: vi.fn(() => ({ all: vi.fn(async () => ({ results: [] })) })) }
        : { bind: vi.fn(() => ({ all: vi.fn(async () => ({ results: [target] })) })) };
    });
    const env = {
      DB: { prepare } as unknown as D1Database,
      CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY: btoa('0123456789abcdef0123456789abcdef'),
    } as Env;
    mocks.readActive
      .mockResolvedValueOnce(readback())
      .mockResolvedValueOnce({ ...readback(), workerVersionId: 'attacker-version', scriptEtag: 'attacker-etag' });

    await refreshDeploymentSecurityInventoryBestEffort(env);
    await refreshDeploymentSecurityInventoryBestEffort(env);

    expect(insertBind.mock.calls[0]?.[6]).toBe('current');
    expect(insertBind.mock.calls[1]?.[6]).toBe('drifted');
    expect(insertBind.mock.calls[1]?.[14]).toBe('worker-version-1');
    expect(insertBind.mock.calls[1]?.[15]).toBe('etag-1');
    expect(insertBind.mock.calls[1]?.[16]).toBe('attacker-version');
    expect(insertBind.mock.calls[1]?.[17]).toBe('attacker-etag');
    expect(insertBind.mock.calls[1]?.[19]).toBeNull();
  });

  test('scans only the exact historical Worker name and records legacy state without changing it', async () => {
    const insertRun = vi.fn(async () => ({ meta: { changes: 1 } }));
    const insertBind = vi.fn((..._values: unknown[]) => ({ run: insertRun }));
    const historicalAll = vi.fn(async () => ({
      results: [
        {
          id: 'connection-1',
          user_id: 'user-1',
          account_id: 'account-1',
          credential_handle: 'credential-1',
          worker_name: 'ghostbuild-cloudflare-app',
          managed_deployment_id: null,
          expected_template_source_sha256: null,
          expected_security_baseline_version: null,
          expected_security_boundary_sha256: null,
          expected_agent_security_d1_id: null,
          requires_agent_cleanup: 1,
          attested_worker_version_id: null,
          attested_script_etag: null,
        },
      ],
    }));
    const existingBind = vi.fn(() => ({ all: vi.fn(async () => ({ results: [] })) }));
    const historicalBind = vi.fn(() => ({ all: historicalAll }));
    const prepare = vi.fn((query: string) => {
      if (!query.trimStart().startsWith('SELECT')) {
        return { bind: insertBind };
      }
      return query.includes('? AS worker_name') ? { bind: historicalBind } : { bind: existingBind };
    });
    const env = {
      DB: { prepare } as unknown as D1Database,
      CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY: btoa('0123456789abcdef0123456789abcdef'),
    } as Env;
    const legacy = readback();
    legacy.bindings = [];
    legacy.crons = [];
    mocks.readActive.mockResolvedValue(legacy);

    await refreshDeploymentSecurityInventoryBestEffort(env);

    expect(existingBind).toHaveBeenCalledWith(2);
    expect(historicalBind).toHaveBeenCalledWith('ghostbuild-cloudflare-app', 'ghostbuild-cloudflare-app', 2);
    expect(mocks.readActive).toHaveBeenCalledWith('ghostbuild-cloudflare-app');
    expect(insertBind.mock.calls[0]).toEqual(
      expect.arrayContaining(['ghostbuild-cloudflare-app', 'legacy_candidate', 'worker-version-1']),
    );
    expect(insertRun).toHaveBeenCalledOnce();
  });

  test('classifies a pre-publish managed intent as not found when no Worker exists', async () => {
    const target = {
      id: 'connection-1',
      user_id: 'user-1',
      account_id: 'account-1',
      credential_handle: 'credential-1',
      worker_name: 'ghostbuild-deployment-1',
      managed_deployment_id: 'deployment-1',
      expected_template_source_sha256: templateSourceSha256,
      expected_security_baseline_version: DEPLOYMENT_SECURITY_BASELINE_VERSION,
      expected_security_boundary_sha256: securityBoundarySha256,
      expected_agent_security_d1_id: 'agent-security-d1-id',
      requires_agent_cleanup: 1,
      attested_worker_version_id: null,
      attested_script_etag: null,
    };
    const insertRun = vi.fn(async () => ({ meta: { changes: 1 } }));
    const insertBind = vi.fn((..._values: unknown[]) => ({ run: insertRun }));
    const prepare = vi.fn((query: string) => {
      if (!query.trimStart().startsWith('SELECT')) {
        return { bind: insertBind };
      }
      return query.includes('? AS worker_name')
        ? { bind: vi.fn(() => ({ all: vi.fn(async () => ({ results: [] })) })) }
        : { bind: vi.fn(() => ({ all: vi.fn(async () => ({ results: [target] })) })) };
    });
    mocks.readActive.mockResolvedValue(null);

    await refreshDeploymentSecurityInventoryBestEffort({
      DB: { prepare } as unknown as D1Database,
      CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY: btoa('0123456789abcdef0123456789abcdef'),
    } as Env);

    expect(insertBind.mock.calls[0]?.[4]).toBe('deployment-1');
    expect(insertBind.mock.calls[0]?.[6]).toBe('not_found');
    expect(insertBind.mock.calls[0]?.[14]).toBeNull();
    expect(insertBind.mock.calls[0]?.[16]).toBeNull();
  });
});

function readback() {
  return {
    providerDeploymentId: 'provider-deployment-1',
    workerVersionId: 'worker-version-1',
    scriptEtag: 'etag-1',
    bindings: [
      { name: 'GHOSTBUILD_TEMPLATE_SOURCE_SHA256', type: 'plain_text', text: templateSourceSha256 },
      {
        name: 'GHOSTBUILD_SECURITY_BASELINE_VERSION',
        type: 'plain_text',
        text: String(DEPLOYMENT_SECURITY_BASELINE_VERSION),
      },
      { name: 'GHOSTBUILD_SECURITY_BOUNDARY_SHA256', type: 'plain_text', text: securityBoundarySha256 },
      { name: 'CF_VERSION_METADATA', type: 'version_metadata' },
      { name: 'AGENT_SECURITY_DB', type: 'd1', database_id: 'agent-security-d1-id' },
    ],
    crons: ['0 3 * * *'],
  };
}

function deployment(): Deployment {
  return {
    id: 'deployment-1',
    chatId: 'chat-1',
    userId: 'user-1',
    connectionId: 'connection-1',
    connectionGeneration: 1,
    executionGeneration: 1,
    buildArtifactKey: 'build-key',
    buildArtifactGeneration: 1,
    snapshotKey: 'snapshot-key',
    status: 'deploying',
    plan: {
      version: 2,
      deploymentId: 'deployment-1',
      sourceSha256: 'a'.repeat(64),
      templateSourceSha256,
      securityBaselineVersion: DEPLOYMENT_SECURITY_BASELINE_VERSION,
      securityBoundarySha256,
      project: { type: 'web_app', bindings: { ai: true, d1: true, r2: true, appAgent: true } },
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
      ],
    },
    planDigest: 'b'.repeat(64),
    approvedDigest: 'b'.repeat(64),
    approvedAt: 1,
    productionUrl: null,
    errorCode: null,
    errorMessage: null,
    createdAt: 1,
    updatedAt: 1,
  };
}
