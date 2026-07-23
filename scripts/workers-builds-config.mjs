const EXPECTED_WORKER = 'ghostbuild';
const EXPECTED_REPOSITORY = 'ferdousbhai/ghostbuild';
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
export const WORKERS_BUILDS_CONTAINER_SOURCE_FILES = [
  'Dockerfile.sandbox',
  'sandbox-tools/package.json',
  'sandbox-tools/pnpm-lock.yaml',
  'sandbox-tools/pnpm-workspace.yaml',
  'sandbox-tools/verify-pnpm-workspace-policy.mjs',
];
const CONTAINER_IMAGE_PATTERN =
  /^registry\.cloudflare\.com\/0af9e0921b880657d84a6c07307f8aef\/ghostbuild-deploymentsandbox@sha256:[a-f0-9]{64}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

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
  requireStringArray(
    errors,
    'workers-builds.production.json containerImage.sourceFiles',
    config?.containerImage?.sourceFiles,
    WORKERS_BUILDS_CONTAINER_SOURCE_FILES,
  );

  const containerImageReference = config?.containerImage?.reference;
  if (typeof containerImageReference !== 'string' || !CONTAINER_IMAGE_PATTERN.test(containerImageReference)) {
    errors.push(
      'workers-builds.production.json containerImage.reference must be an immutable ghostbuild-deploymentsandbox image in the production Cloudflare Registry.',
    );
  }
  if (
    typeof config?.containerImage?.sourceSha256 !== 'string' ||
    !SHA256_PATTERN.test(config.containerImage.sourceSha256)
  ) {
    errors.push('workers-builds.production.json containerImage.sourceSha256 must be a lowercase SHA-256 digest.');
  } else {
    requireEqual(
      errors,
      'workers-builds.production.json containerImage.sourceSha256',
      config.containerImage.sourceSha256,
      containerSourceSha256,
    );
  }

  const workerContainer = Array.isArray(workerConfig?.containers)
    ? workerConfig.containers.find((container) => container?.class_name === 'DeploymentSandbox')
    : undefined;
  requireEqual(errors, 'wrangler.jsonc DeploymentSandbox image', workerContainer?.image, containerImageReference);

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
