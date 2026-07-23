import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  findBuildApprovalErrors,
  findCiWorkflowErrors,
  findCompositeActionSafetyErrors,
  findDurableObjectLifecycleErrors,
  findMissingProvisionScriptPatternErrors,
  findSystemPromptsReleaseWorkflowErrors,
  findWorkerObservabilityErrors,
  findWorkerOAuthStartRateLimitErrors,
  findWorkerChatBackupQuotaErrors,
  findWorkerGcScheduleErrors,
  findWorkerRoutingErrors,
  findWorkerRuntimeSecretErrors,
  findWorkerTelemetryRateLimitErrors,
  findWorkerVariableSourceErrors,
  findWorkflowSafetyErrors,
  verifyProductionConfig,
  workflowPathsFromDirectoryEntries,
} from './verify-production-config.mjs';

describe('findDurableObjectLifecycleErrors', () => {
  const classNames = ['BuilderAgent', 'DeploymentSandbox'];

  it('accepts declarative live SQLite exports for every bound class', () => {
    expect(
      findDurableObjectLifecycleErrors(
        {
          durable_objects: {
            bindings: classNames.map((class_name) => ({ name: class_name, class_name })),
          },
          exports: Object.fromEntries(
            classNames.map((className) => [className, { type: 'durable-object', storage: 'sqlite' }]),
          ),
        },
        'wrangler.jsonc',
        classNames,
      ),
    ).toEqual([]);
  });

  it('rejects the legacy flow and incomplete lifecycle declarations', () => {
    expect(
      findDurableObjectLifecycleErrors(
        {
          migrations: [{ tag: 'v1', new_sqlite_classes: ['BuilderAgent'] }],
          durable_objects: { bindings: [{ name: 'BuilderAgent', class_name: 'BuilderAgent' }] },
          exports: { BuilderAgent: { type: 'durable-object', storage: 'sqlite' } },
        },
        'wrangler.jsonc',
        classNames,
      ),
    ).toEqual([
      'wrangler.jsonc must use declarative exports instead of the legacy Durable Object migrations flow.',
      'wrangler.jsonc must bind the DeploymentSandbox Durable Object.',
      'wrangler.jsonc must declare the DeploymentSandbox Durable Object as a live SQLite export.',
    ]);
  });
});

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

describe('findWorkerVariableSourceErrors', () => {
  it('keeps deploy-provided variables out of checked-in Wrangler state', () => {
    expect(findWorkerVariableSourceErrors({ vars: { STATIC_VALUE: 'ok' } }, 'wrangler.jsonc')).toEqual([]);
    expect(
      findWorkerVariableSourceErrors(
        { keep_vars: true, vars: { CLOUDFLARE_OAUTH_CLIENT_ID: 'dashboard-dependent' } },
        'wrangler.jsonc',
      ),
    ).toEqual([
      'wrangler.jsonc must omit keep_vars so checked-in config and deploy arguments remain the source of truth.',
      'wrangler.jsonc must not commit CLOUDFLARE_OAUTH_CLIENT_ID; inject it from the deploy environment.',
    ]);
  });
});

describe('findWorkerGcScheduleErrors', () => {
  it('requires the bounded deferred-data sweep cron', () => {
    expect(findWorkerGcScheduleErrors({ triggers: { crons: ['*/15 * * * *'] } }, 'wrangler.jsonc')).toEqual([]);
    expect(findWorkerGcScheduleErrors({}, 'wrangler.jsonc')).toEqual([
      'wrangler.jsonc must schedule the bounded deferred-data GC sweep every 15 minutes.',
    ]);
  });
});

describe('findWorkerTelemetryRateLimitErrors', () => {
  it('requires a dedicated 30-per-minute binding', () => {
    expect(
      findWorkerTelemetryRateLimitErrors(
        {
          ratelimits: [
            {
              name: 'CLIENT_TELEMETRY_RATE_LIMITER',
              namespace_id: '1001',
              simple: { limit: 30, period: 60 },
            },
          ],
        },
        'wrangler.jsonc',
      ),
    ).toEqual([]);
    expect(findWorkerTelemetryRateLimitErrors({}, 'wrangler.jsonc')).toEqual([
      'wrangler.jsonc must bind CLIENT_TELEMETRY_RATE_LIMITER.',
    ]);
  });
});

describe('findWorkerOAuthStartRateLimitErrors', () => {
  it('requires a dedicated 10-per-minute namespace', () => {
    expect(
      findWorkerOAuthStartRateLimitErrors(
        {
          ratelimits: [
            {
              name: 'CLOUDFLARE_OAUTH_START_RATE_LIMITER',
              namespace_id: '1002',
              simple: { limit: 10, period: 60 },
            },
          ],
        },
        'wrangler.jsonc',
      ),
    ).toEqual([]);
    expect(findWorkerOAuthStartRateLimitErrors({}, 'wrangler.jsonc')).toEqual([
      'wrangler.jsonc must bind CLOUDFLARE_OAUTH_START_RATE_LIMITER.',
    ]);
    expect(
      findWorkerOAuthStartRateLimitErrors(
        {
          ratelimits: [
            {
              name: 'CLOUDFLARE_OAUTH_START_RATE_LIMITER',
              namespace_id: '1001',
              simple: { limit: 30, period: 10 },
            },
          ],
        },
        'wrangler.jsonc',
      ),
    ).toEqual([
      'wrangler.jsonc OAuth-start rate-limit namespace_id must be "1002"; found "1001".',
      'wrangler.jsonc OAuth-start rate-limit simple.limit must be 10; found 30.',
      'wrangler.jsonc OAuth-start rate-limit simple.period must be 60; found 10.',
    ]);
  });
});

describe('findWorkerChatBackupQuotaErrors', () => {
  it('requires the shedding binding and exact D1 policy configuration', () => {
    expect(
      findWorkerChatBackupQuotaErrors(
        {
          ratelimits: [
            {
              name: 'CHAT_BACKUP_RATE_LIMITER',
              namespace_id: '1003',
              simple: { limit: 240, period: 60 },
            },
          ],
          vars: {
            CHAT_BACKUP_STORAGE_QUOTA_MODE: 'shadow',
            CHAT_BACKUP_STORAGE_LIMIT_BYTES: '1073741824',
            CHAT_BACKUP_STORAGE_LIMIT_OBJECTS: '4096',
            CHAT_BACKUP_REQUESTS_PER_MINUTE: '120',
            CHAT_BACKUP_REQUESTS_PER_DAY: '10000',
          },
        },
        'wrangler.jsonc',
      ),
    ).toEqual([]);
    expect(findWorkerChatBackupQuotaErrors({}, 'wrangler.jsonc')).toEqual([
      'wrangler.jsonc must bind CHAT_BACKUP_RATE_LIMITER.',
      'wrangler.jsonc vars.CHAT_BACKUP_STORAGE_QUOTA_MODE must be "shadow" or "enforce".',
      'wrangler.jsonc vars.CHAT_BACKUP_STORAGE_LIMIT_BYTES must be "1073741824"; found undefined.',
      'wrangler.jsonc vars.CHAT_BACKUP_STORAGE_LIMIT_OBJECTS must be "4096"; found undefined.',
      'wrangler.jsonc vars.CHAT_BACKUP_REQUESTS_PER_MINUTE must be "120"; found undefined.',
      'wrangler.jsonc vars.CHAT_BACKUP_REQUESTS_PER_DAY must be "10000"; found undefined.',
    ]);
  });
});

describe('production config workflow verification helpers', () => {
  it('rejects unreviewed dependency build scripts', () => {
    const workspace = `
minimumReleaseAge: 0
minimumReleaseAgeStrict: false
trustLockfile: true
minimumReleaseAgeExclude:
  - unexpected-installer
strictDepBuilds: true
allowBuilds:
  core-js-pure: true
  esbuild: true
  sharp: true
  workerd: true
  unexpected-installer: true
dangerouslyAllowAllBuilds: true
`;

    expect(findBuildApprovalErrors(workspace, 'pnpm-workspace.yaml')).toContain(
      'pnpm-workspace.yaml allowBuilds must not approve unexpected package unexpected-installer.',
    );
    expect(findBuildApprovalErrors(workspace, 'pnpm-workspace.yaml')).toContain(
      'pnpm-workspace.yaml must not define dangerouslyAllowAllBuilds.',
    );
    expect(findBuildApprovalErrors(workspace, 'pnpm-workspace.yaml')).toEqual(
      expect.arrayContaining([
        'pnpm-workspace.yaml must set minimumReleaseAge to 1440 minutes.',
        'pnpm-workspace.yaml must enable minimumReleaseAgeStrict.',
        'pnpm-workspace.yaml must not define trustLockfile.',
        'pnpm-workspace.yaml must not define minimumReleaseAgeExclude.',
      ]),
    );
  });

  it.each([
    '"trustLockfile": true',
    "'minimumReleaseAgeExclude': [malicious-package]",
    '"dangerouslyAllow\\u0041llBuilds": true',
    '"trustLock\\u0066ile": true',
    '"minimumReleaseAge\\u0045xclude": [malicious-package]',
    'minimumReleaseAge: 1440\nminimumReleaseAge: 0',
    '"minimumRelease\\u0041ge": 0',
    'minimumReleaseAgeStrict: true\nminimumReleaseAgeStrict: false',
  ])('rejects ambiguous or quoted dependency-cooling policy: %s', (weakening) => {
    const workspace = `
minimumReleaseAge: 1440
minimumReleaseAgeStrict: true
strictDepBuilds: true
allowBuilds:
  core-js-pure: true
  esbuild: true
  sharp: true
  workerd: true
${weakening}
`;

    expect(findBuildApprovalErrors(workspace, 'pnpm-workspace.yaml')).not.toEqual([]);
  });

  it('rejects workspace policy text larger than 64 KiB before parsing', () => {
    expect(findBuildApprovalErrors('x'.repeat(64 * 1024 + 1), 'pnpm-workspace.yaml')).toEqual([
      'pnpm-workspace.yaml must not exceed 65536 UTF-8 bytes.',
    ]);
  });

  it('accepts different safe in-tree workspace package shapes', () => {
    expect(
      findBuildApprovalErrors(
        workspacePolicyFixture(['ghostbuild-agent', 'template', 'packages/*', '!packages/legacy/**']),
        'pnpm-workspace.yaml',
      ),
    ).toEqual([]);
    expect(findBuildApprovalErrors(workspacePolicyFixture(['.']), 'template/pnpm-workspace.yaml')).toEqual([]);
  });

  it('allows only the reviewed transitive vulnerability overrides', () => {
    const reviewed = `${workspacePolicyFixture(['ghostbuild-agent', 'template'])}
overrides:
  'brace-expansion@<1.1.16': '1.1.16'
  'brace-expansion@>=2.0.0 <2.1.2': '2.1.2'
`;
    expect(findBuildApprovalErrors(reviewed, 'pnpm-workspace.yaml')).toEqual([]);

    const unreviewed = `${workspacePolicyFixture(['ghostbuild-agent', 'template'])}
overrides:
  'brace-expansion@<1.1.16': '1.1.15'
  'malicious-package@*': 'file:../outside'
`;
    expect(findBuildApprovalErrors(unreviewed, 'pnpm-workspace.yaml')).toEqual(
      expect.arrayContaining([
        'pnpm-workspace.yaml overrides must not change unreviewed dependency brace-expansion@<1.1.16.',
        'pnpm-workspace.yaml overrides must not change unreviewed dependency malicious-package@*.',
        'pnpm-workspace.yaml overrides must pin brace-expansion@<1.1.16 to 1.1.16.',
        'pnpm-workspace.yaml overrides must pin brace-expansion@>=2.0.0 <2.1.2 to 2.1.2.',
      ]),
    );
  });

  it.each([
    '../outside',
    'packages/../../outside',
    '/tmp/package',
    'https://example.com/package',
    'file:../outside',
    'C:\\outside',
    '\\\\server\\share',
    '~/.cache/package',
    '{..,packages}/*',
    '@(../outside|packages)',
    'packages//nested',
    ' packages/*',
    'packages/* ',
  ])('rejects unsafe workspace package path or glob: %s', (workspacePackage) => {
    expect(findBuildApprovalErrors(workspacePolicyFixture([workspacePackage]), 'pnpm-workspace.yaml')).toContain(
      `pnpm-workspace.yaml packages must contain only safe in-tree relative paths or globs; found ${JSON.stringify(workspacePackage)}.`,
    );
  });

  it('requires a non-empty package list and the workspace-root installation guard', () => {
    expect(findBuildApprovalErrors(workspacePolicyFixture([], false), 'pnpm-workspace.yaml')).toEqual(
      expect.arrayContaining([
        'pnpm-workspace.yaml packages must be a non-empty sequence.',
        'pnpm-workspace.yaml must enable ignoreWorkspaceRootCheck.',
      ]),
    );
  });

  it('validates the checked-in workflow structures', () => {
    expect(findCiWorkflowErrors(readFileSync('.github/workflows/ci.yml', 'utf8'), '.github/workflows/ci.yml')).toEqual(
      [],
    );
    expect(
      findSystemPromptsReleaseWorkflowErrors(
        readFileSync('.github/workflows/release_system_prompts.yml', 'utf8'),
        '.github/workflows/release_system_prompts.yml',
      ),
    ).toEqual([]);
  });

  it('requires immutable pins for workflow, reusable-job, and composite-action references', () => {
    const workflow = `
name: Test
on: { workflow_dispatch: {} }
jobs:
  reusable:
    uses: owner/repository/.github/workflows/reusable.yml@main
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: ./.github/actions/setup-and-build
      - uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38
`;
    expect(findWorkflowSafetyErrors(workflow, '.github/workflows/test.yml')).toEqual([
      '.github/workflows/test.yml jobs.reusable.uses must pin external action "owner/repository/.github/workflows/reusable.yml@main" to a full commit SHA.',
      '.github/workflows/test.yml jobs.test.steps[0].uses must pin external action "actions/checkout@v6" to a full commit SHA.',
    ]);
    expect(
      findCompositeActionSafetyErrors(
        `runs:
  using: composite
  steps:
    - uses: actions/setup-node@v6`,
        '.github/actions/setup/action.yml',
      ),
    ).toEqual([
      '.github/actions/setup/action.yml runs.steps[0].uses must pin external action "actions/setup-node@v6" to a full commit SHA.',
    ]);
  });

  it('ignores YAML and shell comments but rejects forbidden commands in actual run steps', () => {
    const workflow = `
name: Test
on: { workflow_dispatch: {} }
# Never run pnpm run deploy:staging or wrangler dev.
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: |
          # wrangler dev is forbidden
          pnpm run deploy:staging
      - run: pnpm run dev
      - run: pnpm wrangler deploy --env-file .env.production
`;
    expect(findWorkflowSafetyErrors(workflow, '.github/workflows/test.yml')).toEqual([
      '.github/workflows/test.yml jobs.test.steps[0].run must not target staging.',
      '.github/workflows/test.yml jobs.test.steps[1].run must not start a local package script.',
      '.github/workflows/test.yml jobs.test.steps[2].run must not load local env files.',
    ]);
  });

  it('rejects duplicate YAML keys and structurally missing CI or release controls', () => {
    expect(findWorkflowSafetyErrors('name: one\nname: two\njobs: {}', '.github/workflows/test.yml')).toEqual([
      expect.stringContaining('must be unambiguous YAML'),
    ]);
    expect(findCiWorkflowErrors('on: { push: {} }\njobs: {}', '.github/workflows/ci.yml')).toEqual([
      '.github/workflows/ci.yml must enable workflow_dispatch.',
      '.github/workflows/ci.yml must run "pnpm run validate" in a job step.',
      '.github/workflows/ci.yml must verify tracked generated files with "git diff --exit-code".',
    ]);
    expect(
      findSystemPromptsReleaseWorkflowErrors(
        'concurrency: { group: wrong, cancel-in-progress: true }\njobs: {}',
        '.github/workflows/release_system_prompts.yml',
      ),
    ).toEqual(
      expect.arrayContaining([
        '.github/workflows/release_system_prompts.yml name must be "Create System Prompts Release"; found undefined.',
        '.github/workflows/release_system_prompts.yml must enable workflow_dispatch.',
        '.github/workflows/release_system_prompts.yml permissions.contents must be "read"; found undefined.',
        '.github/workflows/release_system_prompts.yml concurrency.group must be "system-prompts-release"; found "wrong".',
        '.github/workflows/release_system_prompts.yml concurrency.cancel-in-progress must be false; found true.',
        '.github/workflows/release_system_prompts.yml must define jobs.build.',
        '.github/workflows/release_system_prompts.yml must define jobs.release.',
      ]),
    );
  });

  it('allows required secret names but rejects values and unknown shapes', () => {
    expect(
      findWorkerRuntimeSecretErrors(
        { secrets: { required: ['API_KEY', 'SIGNING_KEY'] } },
        'template/wrangler.jsonc',
        'configure values outside source control',
      ),
    ).toEqual([]);

    expect(
      findWorkerRuntimeSecretErrors(
        { secrets: [{ name: 'API_KEY' }] },
        'template/wrangler.jsonc',
        'generated apps should configure runtime values as Cloudflare bindings',
      ),
    ).toEqual([
      'template/wrangler.jsonc secrets may declare only unique, non-empty names in secrets.required; generated apps should configure runtime values as Cloudflare bindings.',
    ]);

    expect(
      findWorkerRuntimeSecretErrors(
        { secrets: { required: ['API_KEY'], API_KEY: 'secret-value' } },
        'wrangler.jsonc',
        'configure values outside source control',
      ),
    ).toEqual([
      'wrangler.jsonc secrets may declare only unique, non-empty names in secrets.required; configure values outside source control.',
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

  it('uses explicit deploy inputs instead of dashboard-preserved variables', () => {
    expect(verifyProductionConfig()).not.toContain(
      'wrangler.jsonc must omit keep_vars so checked-in config and deploy arguments remain the source of truth.',
    );
    expect(verifyProductionConfig()).not.toContain(
      'wrangler.jsonc must not commit CLOUDFLARE_OAUTH_CLIENT_ID; inject it from the deploy environment.',
    );
  });

  it('pins the least-privilege OAuth scope list in Wrangler configuration', () => {
    expect(verifyProductionConfig()).not.toContain('wrangler.jsonc vars.CLOUDFLARE_OAUTH_SCOPES');
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
    expect(script).toContain('config?.secrets?.required ?? []');
  });
});

function workspacePolicyFixture(packages: string[], ignoreWorkspaceRootCheck = true): string {
  return `
packages:
${packages.map((workspacePackage) => `  - ${JSON.stringify(workspacePackage)}`).join('\n')}
ignoreWorkspaceRootCheck: ${ignoreWorkspaceRootCheck}
minimumReleaseAge: 1440
minimumReleaseAgeIgnoreMissingTime: false
minimumReleaseAgeStrict: true
strictDepBuilds: true
blockExoticSubdeps: true
allowBuilds:
  core-js-pure: true
  esbuild: true
  sharp: true
  workerd: true
`;
}
