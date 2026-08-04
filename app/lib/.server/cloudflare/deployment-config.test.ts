import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  APP_AGENT_SECURITY_BOUNDARY_SHA256,
  DEPLOYMENT_SECURITY_BASELINE_VERSION,
  TEMPLATE_SOURCE_SHA256,
} from './deployment-security-baseline';
import { createTrustedDeploymentConfig } from './deployment-config';
import { evaluateDeploymentSecurityAttestation } from './deployment-security-inventory';
import {
  DEPLOYMENT_PROJECT_ROOT,
  DEPLOYMENT_SECURITY_BASELINE_BINDING,
  DEPLOYMENT_SECURITY_BOUNDARY_BINDING,
  DEPLOYMENT_TEMPLATE_SOURCE_BINDING,
  DEPLOYMENT_VERSION_METADATA_BINDING,
  DEPLOYMENT_WRANGLER_CONFIG_PATH,
} from './deployment-runtime-policy';
import type { ActiveWorkerDeploymentReadback } from './user-account-api';

describe('trusted deployment config', () => {
  test('resolves every generated-project path beneath the Computer project root', () => {
    const webConfig = createTrustedDeploymentConfig(input({ projectType: 'web_app' }));
    const workerConfig = createTrustedDeploymentConfig(input({ projectType: 'worker' }));
    const generatedProjectPaths = [
      webConfig.main,
      webConfig.assets?.directory,
      workerConfig.main,
      ...webConfig.d1_databases!.map((database) => database.migrations_dir),
    ];

    expect(DEPLOYMENT_WRANGLER_CONFIG_PATH.startsWith(`${DEPLOYMENT_PROJECT_ROOT}/`)).toBe(false);
    expect(generatedProjectPaths).not.toContain(undefined);
    for (const generatedPath of generatedProjectPaths) {
      expect(path.posix.isAbsolute(generatedPath!)).toBe(true);
      expect(path.posix.resolve(path.posix.dirname(DEPLOYMENT_WRANGLER_CONFIG_PATH), generatedPath!)).toBe(
        generatedPath,
      );
      expect(generatedPath!.startsWith(`${DEPLOYMENT_PROJECT_ROOT}/`)).toBe(true);
    }
  });

  test('emits the exact bindings and cleanup cron accepted by readback attestation', () => {
    const config = createTrustedDeploymentConfig(input());
    const agentSecurityDatabase = config.d1_databases!.find((database) => database.binding === 'AGENT_SECURITY_DB')!;
    const readback: ActiveWorkerDeploymentReadback = {
      providerDeploymentId: 'provider-deployment-1',
      workerVersionId: 'worker-version-1',
      scriptEtag: 'etag-1',
      bindings: [
        ...Object.entries(config.vars).map(([name, text]) => ({ name, type: 'plain_text' as const, text })),
        { name: config.version_metadata.binding, type: 'version_metadata' },
        {
          name: agentSecurityDatabase.binding,
          type: 'd1',
          database_id: agentSecurityDatabase.database_id,
        },
      ],
      crons: config.triggers!.crons,
    };

    expect(Object.keys(config.vars).sort()).toEqual(
      [
        DEPLOYMENT_SECURITY_BASELINE_BINDING,
        DEPLOYMENT_SECURITY_BOUNDARY_BINDING,
        DEPLOYMENT_TEMPLATE_SOURCE_BINDING,
      ].sort(),
    );
    expect(config.version_metadata.binding).toBe(DEPLOYMENT_VERSION_METADATA_BINDING);
    expect(
      evaluateDeploymentSecurityAttestation({
        readback,
        expectedTemplateSourceSha256: TEMPLATE_SOURCE_SHA256,
        expectedSecurityBaselineVersion: DEPLOYMENT_SECURITY_BASELINE_VERSION,
        expectedSecurityBoundarySha256: APP_AGENT_SECURITY_BOUNDARY_SHA256,
        expectedAgentSecurityD1DatabaseId: agentSecurityDatabase.database_id,
        requireExpectedAgentSecurityD1Identity: true,
        requiresAgentCleanup: true,
      }).status,
    ).toBe('current');
  });
});

function input(overrides: { projectType?: 'web_app' | 'worker' } = {}) {
  return {
    accountId: 'account-id',
    workerName: 'ghostbuild-deployment-1',
    projectType: overrides.projectType ?? ('web_app' as const),
    workersAi: true,
    appAgent: true,
    d1DatabaseId: 'application-d1-id',
    d1DatabaseName: 'ghostbuild-deployment-1',
    agentSecurityD1DatabaseId: 'agent-security-d1-id',
    agentSecurityD1DatabaseName: 'ghostbuild-deployment-1-agent-security',
    r2BucketName: 'ghostbuild-deployment-1-storage',
    securityBaselineVersion: String(DEPLOYMENT_SECURITY_BASELINE_VERSION),
    securityBoundarySha256: APP_AGENT_SECURITY_BOUNDARY_SHA256,
    templateSourceSha256: TEMPLATE_SOURCE_SHA256,
  };
}
