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
      'an unexpected binding',
      (value: ReturnType<typeof readback>) => value.bindings.push({ name: 'UNAPPROVED', type: 'plain_text' }),
    ],
    ['changed compatibility flags', (value: ReturnType<typeof readback>) => value.compatibilityFlags.push('unsafe')],
    [
      'the wrong security D1',
      (value: ReturnType<typeof readback>) => {
        const binding = value.bindings.find((candidate) => candidate.name === 'AGENT_SECURITY_DB');
        if (binding) {
          binding.database_id = 'wrong-d1';
        }
      },
    ],
    [
      'the wrong KV namespace',
      (value: ReturnType<typeof readback>) => {
        value.bindings.push({ name: 'APP_CACHE', type: 'kv_namespace', namespace_id: 'wrong-kv' });
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
        expectedKvNamespaceId: 'application-kv-id',
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
        expectedKvNamespaceId: 'application-kv-id',
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
    expectedKvNamespaceId: 'application-kv-id',
    requireExpectedAgentSecurityD1Identity: true,
    requiresAgentCleanup: true,
    expectedCompatibilityDate: '2026-07-21',
    expectedCompatibilityFlags: ['nodejs_compat'],
    expectedBindings: [
      { name: 'GHOSTBUILD_TEMPLATE_SOURCE_SHA256', type: 'plain_text' },
      { name: 'GHOSTBUILD_SECURITY_BASELINE_VERSION', type: 'plain_text' },
      { name: 'GHOSTBUILD_SECURITY_BOUNDARY_SHA256', type: 'plain_text' },
      { name: 'CF_VERSION_METADATA', type: 'version_metadata' },
      { name: 'AI', type: 'ai' },
      { name: 'DB', type: 'd1' },
      { name: 'AGENT_SECURITY_DB', type: 'd1' },
      { name: 'APP_CACHE', type: 'kv_namespace' },
      { name: 'AppAgent', type: 'durable_object_namespace' },
    ],
  });
}

function readback(): ActiveWorkerDeploymentReadback {
  return {
    providerDeploymentId: 'provider-deployment-1',
    workerVersionId: 'worker-version-1',
    scriptEtag: 'etag-1',
    compatibilityDate: '2026-07-21',
    compatibilityFlags: ['nodejs_compat'],
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
      { name: 'AI', type: 'ai' },
      { name: 'DB', type: 'd1', database_id: 'application-d1-id' },
      { name: 'AGENT_SECURITY_DB', type: 'd1', database_id: 'agent-security-d1-id' },
      { name: 'APP_CACHE', type: 'kv_namespace', namespace_id: 'application-kv-id' },
      { name: 'AppAgent', type: 'durable_object_namespace' },
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
      version: 4,
      deploymentId: 'deployment-1',
      sourceSha256: 'a'.repeat(64),
      templateSourceSha256: TEMPLATE_SOURCE_SHA256,
      securityBaselineVersion: DEPLOYMENT_SECURITY_BASELINE_VERSION,
      securityBoundarySha256: APP_AGENT_SECURITY_BOUNDARY_SHA256,
      project: { type: 'web_app', bindings: { ai: true, d1: true, r2: false, kv: true, appAgent: true } },
      resources: [
        { type: 'worker', logicalName: 'app', proposedName: 'ghostbuild-deployment-1' },
        { type: 'd1', logicalName: 'AGENT_SECURITY_DB', proposedName: 'ghostbuild-deployment-1-agent-security' },
        { type: 'kv', logicalName: 'APP_CACHE', proposedName: 'ghostbuild-deployment-1-cache' },
      ],
    },
    planDigest: 'b'.repeat(64),
    productionUrl: null,
    errorCode: null,
    errorMessage: null,
    createdAt: 1,
    updatedAt: 1,
  };
}
