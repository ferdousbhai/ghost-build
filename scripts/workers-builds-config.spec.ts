import { describe, expect, it } from 'vitest';
import { findWorkersBuildsConfigErrors } from './workers-builds-config.mjs';

const containerReference =
  'registry.cloudflare.com/0af9e0921b880657d84a6c07307f8aef/ghostbuild-deploymentsandbox@sha256:' + 'a'.repeat(64);
const containerSourceSha256 = 'b'.repeat(64);
const validConfig = {
  worker: 'ghostbuild',
  repository: 'ferdousbhai/ghostbuild',
  productionBranch: 'main',
  rootDirectory: '/',
  buildCommand: 'pnpm run workers-builds:build',
  deployCommand: 'pnpm run workers-builds:deploy',
  nonProductionBuilds: true,
  nonProductionDeployCommand: 'pnpm run workers-builds:preview',
  pathIncludes: ['*'],
  pathExcludes: [],
  buildCaching: true,
  buildTokenName: 'account-workers-builds-production',
  containerImage: {
    reference: containerReference,
    sourceFiles: [
      'Dockerfile.sandbox',
      'sandbox-tools/package.json',
      'sandbox-tools/pnpm-lock.yaml',
      'sandbox-tools/pnpm-workspace.yaml',
      'sandbox-tools/verify-pnpm-workspace-policy.mjs',
    ],
    sourceSha256: containerSourceSha256,
  },
  buildVariables: {
    NODE_VERSION: '26.3.0',
    PNPM_VERSION: '11.14.0',
    SKIP_DEPENDENCY_INSTALL: '1',
  },
  requiredBuildVariables: ['CLOUDFLARE_OAUTH_CLIENT_ID'],
};

const packageJson = {
  packageManager: 'pnpm@11.14.0',
  scripts: {
    'workers-builds:build':
      'pnpm install --frozen-lockfile && node scripts/check-workers-builds-environment.mjs && pnpm run validate && git diff --exit-code',
    'workers-builds:deploy': 'node scripts/deploy-production.mjs --check-workers-builds && pnpm run release:production',
    'workers-builds:preview': 'node scripts/upload-workers-builds-preview.mjs',
  },
};

describe('Workers Builds production configuration', () => {
  it('accepts the reviewed production trigger contract', () => {
    expect(
      findWorkersBuildsConfigErrors({
        config: validConfig,
        packageJson,
        nvmrc: '26.3.0\n',
        githubWorkflowPaths: [],
        githubCompositeActionExists: false,
        workerConfig: { containers: [{ class_name: 'DeploymentSandbox', image: containerReference }] },
        containerSourceSha256,
      }),
    ).toEqual([]);
  });

  it('rejects disabled previews, mutable toolchains, unreviewed variables, and GitHub Actions', () => {
    expect(
      findWorkersBuildsConfigErrors({
        config: {
          ...validConfig,
          nonProductionBuilds: false,
          nonProductionDeployCommand: 'wrangler deploy',
          buildTokenName: 'per-project-token',
          containerImage: { ...validConfig.containerImage, sourceSha256: 'c'.repeat(64) },
          buildVariables: { ...validConfig.buildVariables, UNREVIEWED_SECRET: 'value' },
        },
        packageJson: { ...packageJson, packageManager: 'pnpm@latest' },
        nvmrc: 'node\n',
        githubWorkflowPaths: ['.github/workflows/ci.yml', '.github/workflows/deploy.yml'],
        githubCompositeActionExists: true,
        workerConfig: { containers: [{ class_name: 'DeploymentSandbox', image: './Dockerfile.sandbox' }] },
        containerSourceSha256,
      }),
    ).toEqual(
      expect.arrayContaining([
        'workers-builds.production.json nonProductionBuilds must be true; found false.',
        'workers-builds.production.json nonProductionDeployCommand must be "pnpm run workers-builds:preview"; found "wrangler deploy".',
        'workers-builds.production.json buildTokenName must be "account-workers-builds-production"; found "per-project-token".',
        'workers-builds.production.json buildVariables must not contain unreviewed variables: UNREVIEWED_SECRET.',
        `workers-builds.production.json containerImage.sourceSha256 must be "${containerSourceSha256}"; found "${'c'.repeat(64)}".`,
        `wrangler.jsonc DeploymentSandbox image must be "${containerReference}"; found "./Dockerfile.sandbox".`,
        'package.json packageManager must be "pnpm@11.14.0"; found "pnpm@latest".',
        '.nvmrc must be "26.3.0"; found "node".',
        'GitHub Actions workflows must not exist; Cloudflare Workers Builds is the only CI/CD provider. Found: .github/workflows/ci.yml, .github/workflows/deploy.yml.',
        '.github/actions/setup-and-build/action.yaml must not exist; the Cloudflare build command owns toolchain setup.',
      ]),
    );
  });
});
