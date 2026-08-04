const EXPECTED_WORKER = 'ghostbuild';
const EXPECTED_REPOSITORY = 'ferdousbhai/ghost-build';
const EXPECTED_BRANCH = 'main';
const EXPECTED_BUILD_COMMAND = 'pnpm run workers-builds:build';
const EXPECTED_DEPLOY_COMMAND = 'pnpm run workers-builds:deploy';
const EXPECTED_PREVIEW_COMMAND = 'pnpm run workers-builds:preview';
const EXPECTED_TOKEN_NAME = 'account-workers-builds-production';
const EXPECTED_BUILD_VARIABLES = {
  NODE_VERSION: '26.3.0',
  PNPM_VERSION: '11.14.0',
  SKIP_DEPENDENCY_INSTALL: '1',
};
const EXPECTED_REQUIRED_BUILD_VARIABLES = ['CLOUDFLARE_OAUTH_CLIENT_ID'];
export const WORKERS_BUILDS_CONTAINER_SOURCE_FILES = [];

export function findWorkersBuildsConfigErrors({
  config,
  packageJson,
  nvmrc,
  githubWorkflowPaths,
  githubCompositeActionExists,
  workerConfig,
  containerSourceSha256,
}) {
  const errors = [];
  requireEqual(errors, 'workers-builds.production.json worker', config?.worker, EXPECTED_WORKER);
  requireEqual(errors, 'workers-builds.production.json repository', config?.repository, EXPECTED_REPOSITORY);
  requireEqual(errors, 'workers-builds.production.json productionBranch', config?.productionBranch, EXPECTED_BRANCH);
  requireEqual(errors, 'workers-builds.production.json rootDirectory', config?.rootDirectory, '/');
  requireEqual(errors, 'workers-builds.production.json buildCommand', config?.buildCommand, EXPECTED_BUILD_COMMAND);
  requireEqual(errors, 'workers-builds.production.json deployCommand', config?.deployCommand, EXPECTED_DEPLOY_COMMAND);
  requireEqual(errors, 'workers-builds.production.json nonProductionBuilds', config?.nonProductionBuilds, true);
  requireEqual(
    errors,
    'workers-builds.production.json nonProductionDeployCommand',
    config?.nonProductionDeployCommand,
    EXPECTED_PREVIEW_COMMAND,
  );
  requireEqual(errors, 'workers-builds.production.json buildCaching', config?.buildCaching, true);
  requireEqual(errors, 'workers-builds.production.json buildTokenName', config?.buildTokenName, EXPECTED_TOKEN_NAME);
  requireStringArray(errors, 'workers-builds.production.json pathIncludes', config?.pathIncludes, ['*']);
  requireStringArray(errors, 'workers-builds.production.json pathExcludes', config?.pathExcludes, []);
  requireStringArray(
    errors,
    'workers-builds.production.json requiredBuildVariables',
    config?.requiredBuildVariables,
    EXPECTED_REQUIRED_BUILD_VARIABLES,
  );
  if (config?.containerImage !== undefined) {
    errors.push('workers-builds.production.json must not build a Ghostbuild-owned Sandbox image.');
  }
  if (Array.isArray(workerConfig?.containers) && workerConfig.containers.length > 0) {
    errors.push('wrangler.jsonc must not bind Ghostbuild-owned Containers.');
  }

  if (!isRecord(config?.buildVariables)) {
    errors.push('workers-builds.production.json buildVariables must be an object.');
  } else {
    for (const [name, value] of Object.entries(EXPECTED_BUILD_VARIABLES)) {
      requireEqual(errors, `workers-builds.production.json buildVariables.${name}`, config.buildVariables[name], value);
    }
    const unexpected = Object.keys(config.buildVariables).filter((name) => !(name in EXPECTED_BUILD_VARIABLES));
    if (unexpected.length > 0) {
      errors.push(
        `workers-builds.production.json buildVariables must not contain unreviewed variables: ${unexpected.join(', ')}.`,
      );
    }
  }

  const scripts = packageJson?.scripts;
  requireEqual(
    errors,
    'package.json scripts.workers-builds:build',
    scripts?.['workers-builds:build'],
    [
      'pnpm install --frozen-lockfile',
      'node scripts/check-workers-builds-environment.mjs',
      'pnpm run validate',
      'git diff --exit-code',
    ].join(' && '),
  );
  requireEqual(
    errors,
    'package.json scripts.workers-builds:deploy',
    scripts?.['workers-builds:deploy'],
    [
      'node scripts/deploy-production.mjs --check-workers-builds',
      'pnpm run provision:production:check',
      'pnpm run verify:production-config',
      'pnpm run verify:workers-builds-config',
      'pnpm run d1:bookmark:production',
      'pnpm run d1:migrations:apply:production',
      'node scripts/deploy-production.mjs',
    ].join(' && '),
  );
  requireEqual(
    errors,
    'package.json scripts.workers-builds:preview',
    scripts?.['workers-builds:preview'],
    'node scripts/upload-workers-builds-preview.mjs',
  );
  requireEqual(errors, 'package.json packageManager', packageJson?.packageManager, 'pnpm@11.14.0');
  requireEqual(errors, '.nvmrc', nvmrc?.trim(), '26.3.0');

  if (Array.isArray(githubWorkflowPaths) && githubWorkflowPaths.length > 0) {
    errors.push(
      `GitHub Actions workflows must not exist; Cloudflare Workers Builds is the only CI/CD provider. Found: ${githubWorkflowPaths.join(', ')}.`,
    );
  }
  if (githubCompositeActionExists) {
    errors.push(
      '.github/actions/setup-and-build/action.yaml must not exist; the Cloudflare build command owns toolchain setup.',
    );
  }
  return errors;
}

function requireEqual(errors, label, actual, expected) {
  if (actual !== expected) {
    errors.push(`${label} must be ${JSON.stringify(expected)}; found ${JSON.stringify(actual)}.`);
  }
}

function requireStringArray(errors, label, actual, expected) {
  if (
    !Array.isArray(actual) ||
    actual.length !== expected.length ||
    actual.some((value, index) => typeof value !== 'string' || value !== expected[index])
  ) {
    errors.push(`${label} must be ${JSON.stringify(expected)}; found ${JSON.stringify(actual)}.`);
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
