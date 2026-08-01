import { describe, expect, test, vi } from 'vitest';
import type { Deployment } from './deployment-repository';
import {
  attestManagedDeploymentSecurity,
  DeploymentSecurityAttestationError,
  evaluateDeploymentSecurityAttestation,
} from './deployment-security-inventory';
import {
  APP_AGENT_SECURITY_BOUNDARY_SHA256,
  DEPLOYMENT_SECURITY_BASELINE_VERSION,
  TEMPLATE_SOURCE_SHA256,
} from './deployment-security-baseline';
import type { ActiveWorkerDeploymentReadback } from './user-account-api';

describe('deployment security attestation', () => {
  test('accepts exact trusted metadata, version identity, protected D1, and cleanup schedule', () => {
    expect(evaluate(readback()).status).toBe('current');
  });

  test.each([
    [
      'missing version metadata',
      (value: ReturnType<typeof readback>) => {
        value.bindings = value.bindings.filter((binding) => binding.name !== 'CF_VERSION_METADATA');
      },
    ],
    ['an added schedule', (value: ReturnType<typeof readback>) => value.crons.push('*/5 * * * *')],
    [
      'the wrong security D1',
      (value: ReturnType<typeof readback>) => {
        const binding = value.bindings.find((candidate) => candidate.name === 'AGENT_SECURITY_DB');
        if (binding) {
          binding.database_id = 'wrong-d1';
        }
      },
    ],
  ])('rejects %s as drift', (_name, mutate) => {
    const value = readback();
    mutate(value);
    expect(evaluate(value).status).toBe('drifted');
  });

  test('polls until the exact published Worker version becomes active', async () => {
    const previous = { ...readback(), workerVersionId: 'previous-version' };
    const published = { ...readback(), workerVersionId: 'published-version' };
    const readActiveWorkerDeployment = vi.fn().mockResolvedValueOnce(previous).mockResolvedValueOnce(published);
    const retryDelay = vi.fn(async () => undefined);

    await expect(
      attestManagedDeploymentSecurity({
        deployment: deployment(),
        workerName: 'ghostbuild-deployment-1',
        accountApi: { readActiveWorkerDeployment },
        expectedPublishedVersionId: 'published-version',
        expectedAgentSecurityD1DatabaseId: 'agent-security-d1-id',
        attempts: 2,
        retryDelay,
      }),
    ).resolves.toMatchObject({ status: 'current', workerVersionId: 'published-version' });
    expect(readActiveWorkerDeployment).toHaveBeenCalledTimes(2);
    expect(retryDelay).toHaveBeenCalledOnce();
  });

  test('fails closed without persisting a write-only inventory', async () => {
    await expect(
      attestManagedDeploymentSecurity({
        deployment: deployment(),
        workerName: 'ghostbuild-deployment-1',
        accountApi: { readActiveWorkerDeployment: vi.fn(async () => null) },
        expectedPublishedVersionId: 'published-version',
        expectedAgentSecurityD1DatabaseId: 'agent-security-d1-id',
        attempts: 1,
      }),
    ).rejects.toBeInstanceOf(DeploymentSecurityAttestationError);
  });
});

function evaluate(value: ReturnType<typeof readback>) {
  return evaluateDeploymentSecurityAttestation({
    readback: value,
    expectedTemplateSourceSha256: TEMPLATE_SOURCE_SHA256,
    expectedSecurityBaselineVersion: DEPLOYMENT_SECURITY_BASELINE_VERSION,
    expectedSecurityBoundarySha256: APP_AGENT_SECURITY_BOUNDARY_SHA256,
    expectedAgentSecurityD1DatabaseId: 'agent-security-d1-id',
    requireExpectedAgentSecurityD1Identity: true,
    requiresAgentCleanup: true,
  });
}

function readback(): ActiveWorkerDeploymentReadback {
  return {
    providerDeploymentId: 'provider-deployment-1',
    workerVersionId: 'worker-version-1',
    scriptEtag: 'etag-1',
    bindings: [
      { name: 'GHOSTBUILD_TEMPLATE_SOURCE_SHA256', type: 'plain_text', text: TEMPLATE_SOURCE_SHA256 },
      {
        name: 'GHOSTBUILD_SECURITY_BASELINE_VERSION',
        type: 'plain_text',
        text: String(DEPLOYMENT_SECURITY_BASELINE_VERSION),
      },
      {
        name: 'GHOSTBUILD_SECURITY_BOUNDARY_SHA256',
        type: 'plain_text',
        text: APP_AGENT_SECURITY_BOUNDARY_SHA256,
      },
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
    workspaceReference: `workspace-runtime:project:1:${'a'.repeat(64)}`,
    status: 'deploying',
    plan: {
      version: 2,
      deploymentId: 'deployment-1',
      sourceSha256: 'a'.repeat(64),
      templateSourceSha256: TEMPLATE_SOURCE_SHA256,
      securityBaselineVersion: DEPLOYMENT_SECURITY_BASELINE_VERSION,
      securityBoundarySha256: APP_AGENT_SECURITY_BOUNDARY_SHA256,
      project: { type: 'web_app', bindings: { ai: true, d1: true, r2: false, appAgent: true } },
      billing: {
        infrastructure: 'user_cloudflare_account',
        workersAi: 'user_cloudflare_account',
        workersPaidUpgrade: 'explicit_user_authorization_required',
      },
      resources: [
        { type: 'worker', logicalName: 'app', proposedName: 'ghostbuild-deployment-1' },
        { type: 'd1', logicalName: 'AGENT_SECURITY_DB', proposedName: 'ghostbuild-deployment-1-agent-security' },
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
