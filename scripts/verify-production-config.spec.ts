import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  findForbiddenWorkflowCommandErrors,
  findMissingProvisionScriptPatternErrors,
  findMissingWorkflowTextErrors,
  findWorkerObservabilityErrors,
  findWorkerRoutingErrors,
  findWorkerRuntimeSecretErrors,
  findWorkflowSequenceErrors,
  verifyProductionConfig,
  workflowPathsFromDirectoryEntries,
} from './verify-production-config.mjs';

describe('findWorkerRoutingErrors', () => {
  it('accepts the production custom domain with workers.dev disabled', () => {
    expect(
      findWorkerRoutingErrors(
        {
          workers_dev: false,
          routes: [{ pattern: 'ghostbuild.dev', custom_domain: true }],
        },
        'wrangler.jsonc',
        'ghostbuild.dev',
      ),
    ).toEqual([]);
  });

  it('rejects a missing custom domain and public workers.dev endpoint', () => {
    expect(findWorkerRoutingErrors({}, 'wrangler.jsonc', 'ghostbuild.dev')).toEqual([
      'wrangler.jsonc workers_dev must be false so production is served only from the custom domain.',
      'wrangler.jsonc must configure "ghostbuild.dev" as a custom domain.',
    ]);
  });
});

describe('production config workflow verification helpers', () => {
  it('reports missing required workflow text', () => {
    expect(
      findMissingWorkflowTextErrors('name: Deploy', '.github/workflows/deploy.yml', ['name: Production Deploy']),
    ).toEqual(['.github/workflows/deploy.yml must contain "name: Production Deploy".']);
  });

  it('requires production deploy commands in order', () => {
    const workflow = `
      run: pnpm run typecheck
      run: pnpm run verify:stack
      uses: cloudflare/wrangler-action@v4
      command: deploy --var COMMIT_SHA:\${{ github.sha }}
      name: Verify live deployment version
    `;

    expect(
      findWorkflowSequenceErrors(workflow, '.github/workflows/deploy.yml', [
        'pnpm run verify:stack',
        'pnpm run typecheck',
        'uses: cloudflare/wrangler-action@v4',
        'command: deploy --var COMMIT_SHA:${{ github.sha }}',
        'name: Verify live deployment version',
      ]),
    ).toEqual(['.github/workflows/deploy.yml must run "pnpm run typecheck" in the production deploy sequence.']);
  });

  it('requires the official Cloudflare Wrangler action for production deploys', () => {
    const workflow = `
      name: Production Deploy
      uses: cloudflare/wrangler-action@v4
      with:
        apiToken: \${{ secrets.CLOUDFLARE_API_TOKEN }}
        accountId: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        packageManager: pnpm
        command: deploy --var COMMIT_SHA:\${{ github.sha }}
      name: Verify live deployment version
      env:
        EXPECTED_SHA: \${{ github.sha }}
      run: curl https://ghostbuild.dev/api/version
    `;

    expect(
      findMissingWorkflowTextErrors(workflow, '.github/workflows/deploy.yml', [
        'uses: cloudflare/wrangler-action@v4',
        'apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}',
        'accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}',
        'packageManager: pnpm',
        'command: deploy --var COMMIT_SHA:${{ github.sha }}',
        'name: Verify live deployment version',
        'EXPECTED_SHA: ${{ github.sha }}',
        'https://ghostbuild.dev/api/version',
      ]),
    ).toEqual([]);

    expect(
      findMissingWorkflowTextErrors('run: pnpm wrangler deploy', '.github/workflows/deploy.yml', [
        'uses: cloudflare/wrangler-action@v4',
      ]),
    ).toEqual(['.github/workflows/deploy.yml must contain "uses: cloudflare/wrangler-action@v4".']);
  });

  it('rejects staging and local dev commands in workflows', () => {
    const workflow = `
      run: pnpm run deploy:staging
      run: pnpm run dev
      run: wrangler dev
      run: pnpm wrangler deploy --env-file .env.production
      run: source .dev.vars
    `;

    expect(findForbiddenWorkflowCommandErrors(workflow, '.github/workflows/deploy.yml')).toEqual([
      '.github/workflows/deploy.yml:2 must not target staging.',
      '.github/workflows/deploy.yml:3 must not start a local package script.',
      '.github/workflows/deploy.yml:4 must not start Wrangler dev.',
      '.github/workflows/deploy.yml:5 must not load local env files.',
      '.github/workflows/deploy.yml:6 must not load local env files.',
    ]);
  });

  it('rejects Worker runtime secrets declared in wrangler config', () => {
    expect(
      findWorkerRuntimeSecretErrors(
        { secrets: [{ name: 'API_KEY' }] },
        'template/wrangler.jsonc',
        'generated apps should configure runtime values as Cloudflare bindings',
      ),
    ).toEqual([
      'template/wrangler.jsonc must not declare Worker runtime secrets; generated apps should configure runtime values as Cloudflare bindings.',
    ]);

    expect(
      findWorkerRuntimeSecretErrors({}, 'wrangler.jsonc', 'configure runtime values as Cloudflare bindings'),
    ).toEqual([]);
  });

  it('requires explicit Worker logs and traces sampling', () => {
    expect(
      findWorkerObservabilityErrors(
        {
          observability: {
            enabled: true,
            logs: { enabled: true, head_sampling_rate: 0.6 },
            traces: { enabled: true, head_sampling_rate: 0.05 },
          },
        },
        'wrangler.jsonc',
      ),
    ).toEqual([]);

    expect(findWorkerObservabilityErrors({ observability: { enabled: true } }, 'wrangler.jsonc')).toEqual([
      'wrangler.jsonc observability.logs.enabled must be true; found undefined.',
      'wrangler.jsonc observability.logs.head_sampling_rate must be 0.6; found undefined.',
      'wrangler.jsonc observability.traces.enabled must be true; found undefined.',
      'wrangler.jsonc observability.traces.head_sampling_rate must be 0.05; found undefined.',
    ]);
  });

  it('requires production provisioning scripts to perform required Cloudflare setup without local secret gates', () => {
    expect(
      findMissingProvisionScriptPatternErrors('pnpm wrangler r2 bucket list', 'scripts/provision.mjs', [
        { pattern: /wrangler d1 list/, description: 'list Cloudflare D1 databases' },
      ]),
    ).toEqual(['scripts/provision.mjs must list Cloudflare D1 databases.']);

    expect(
      findMissingProvisionScriptPatternErrors('pnpm wrangler d1 list', 'scripts/provision.mjs', [
        { pattern: /wrangler d1 list/, description: 'list Cloudflare D1 databases' },
      ]),
    ).toEqual([]);
  });

  it('does not require local Cloudflare credential env vars for config verification', () => {
    expect(verifyProductionConfig()).not.toContain(
      'CLOUDFLARE_API_TOKEN must be present in the production deploy environment.',
    );
    expect(verifyProductionConfig()).not.toContain(
      'CLOUDFLARE_ACCOUNT_ID must be present in the production deploy environment.',
    );
  });

  it('discovers every YAML workflow file for production guard checks', () => {
    expect(workflowPathsFromDirectoryEntries(['deploy.yml', 'ci.yaml', 'README.md', 'nested.yml.bak'])).toEqual([
      '.github/workflows/ci.yaml',
      '.github/workflows/deploy.yml',
    ]);
  });

  it('keeps Cloudflare type generation bounded in browser containers', () => {
    const script = readFileSync('template/scripts/cf-typegen.mjs', 'utf8');

    expect(script).toContain('timeout: WRANGLER_TYPES_TIMEOUT_MS');
    expect(script).toContain('experimental_generateTypes');
    expect(script).toContain('includeRuntime: false');
    expect(script).toContain('withPackagedRuntimeTypes');
  });
});
