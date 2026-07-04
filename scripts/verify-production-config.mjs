import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse, printParseErrorCode } from 'jsonc-parser';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const REQUIRED_COMPATIBILITY_DATE = '2026-06-30';
const PLACEHOLDER_D1_ID = '00000000-0000-0000-0000-000000000000';
const REQUIRED_LOGS_SAMPLING_RATE = 0.6;
const REQUIRED_TRACES_SAMPLING_RATE = 0.05;
const FORBIDDEN_PRODUCTION_SCRIPT_NAMES = new Set([
  'dev',
  'start',
  'preview',
  'deploy:local',
  'deploy:staging',
  'dev:local',
  'start:local',
  'start:staging',
]);
const REQUIRED_DEPLOY_WORKFLOW_TEXT = [
  'name: Production Deploy',
  'branches:\n      - main',
  'environment:\n      name: production',
  'CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}',
  'CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}',
  'uses: cloudflare/wrangler-action@v3',
  'apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}',
  'accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}',
  'packageManager: pnpm',
  'command: deploy',
];
const REQUIRED_DEPLOY_WORKFLOW_SEQUENCE = [
  'pnpm run verify:stack',
  'pnpm run verify:template',
  'pnpm run typecheck',
  'pnpm run provision:production',
  'pnpm run verify:production-config',
  'pnpm run build',
  'pnpm run lint',
  'pnpm run test',
  'pnpm run knip',
  'pnpm run d1:migrations:apply:production',
  'uses: cloudflare/wrangler-action@v3',
  'command: deploy',
];
const REQUIRED_VERIFICATION_WORKFLOW_TEXT = ['pnpm run verify:stack', 'pnpm run verify:template'];
const STAGING_PATTERN = /\bstaging\b/i;
const LOCAL_ENV_FILE_PATTERN =
  /(?:^|\s)--env-file(?:[=\s]|$)|(?:^|[\s"'`])(?:\.env(?:\.[\w.-]+)?|\.dev\.vars(?:\.[\w.-]+)?)(?=$|[\s"'`])/;
const LOCAL_DEV_SERVER_COMMAND_PATTERNS = [
  { pattern: /\bwrangler\s+dev\b/, workflowReason: 'start Wrangler dev' },
  { pattern: /\bvite\s+(?:--host|dev)\b/, workflowReason: 'start Vite dev' },
];
const FORBIDDEN_WORKFLOW_COMMAND_PATTERNS = [
  { pattern: STAGING_PATTERN, reason: 'target staging' },
  ...LOCAL_DEV_SERVER_COMMAND_PATTERNS.map(({ pattern, workflowReason }) => ({ pattern, reason: workflowReason })),
  { pattern: /\bpnpm\s+(?:run\s+)?(?:dev|start|preview)\b/, reason: 'start a local package script' },
  { pattern: /\bnpm\s+(?:run\s+)?(?:dev|start|preview)\b/, reason: 'start a local package script' },
  { pattern: LOCAL_ENV_FILE_PATTERN, reason: 'load local env files' },
];
const REQUIRED_PROVISION_SCRIPT_PATTERNS = [
  {
    pattern: /\[['"]d1['"],\s*['"]list['"],\s*['"]--json['"]\]/s,
    description: 'list Cloudflare D1 databases',
  },
  {
    pattern: /\[['"]d1['"],\s*['"]create['"],\s*databaseName\]/s,
    description: 'create the production D1 database when missing',
  },
  {
    pattern: /\[['"]d1_databases['"],\s*d1Index,\s*['"]database_id['"]/s,
    description: 'write the non-secret D1 database_id into wrangler.jsonc',
  },
  {
    pattern: /\[['"]r2['"],\s*['"]bucket['"],\s*['"]list['"]\]/s,
    description: 'list Cloudflare R2 buckets',
  },
  {
    pattern: /\[['"]r2['"],\s*['"]bucket['"],\s*['"]create['"],\s*bucketName\]/s,
    description: 'create the production R2 bucket when missing',
  },
];

function readJsoncConfig(path, label) {
  const raw = readFileSync(resolve(rootDir, path), 'utf8');
  const parseErrors = [];
  const config = parse(raw, parseErrors, { allowTrailingComma: true });

  for (const error of parseErrors) {
    errors.push(`${label} has invalid JSONC: ${printParseErrorCode(error.error)} at offset ${error.offset}.`);
  }

  return config;
}

function readJsonConfig(path, label) {
  try {
    return JSON.parse(readFileSync(resolve(rootDir, path), 'utf8'));
  } catch (error) {
    errors.push(`${label} must be valid JSON: ${error instanceof Error ? error.message : String(error)}.`);
    return undefined;
  }
}

function readTextConfig(path, label) {
  try {
    return readFileSync(resolve(rootDir, path), 'utf8');
  } catch (error) {
    errors.push(`${label} must exist: ${error instanceof Error ? error.message : String(error)}.`);
    return undefined;
  }
}

function requireEqual(label, actual, expected) {
  if (actual !== expected) {
    errors.push(`${label} must be ${JSON.stringify(expected)}; found ${JSON.stringify(actual)}.`);
  }
}

function requireArrayIncludes(label, values, expected) {
  if (!Array.isArray(values) || !values.includes(expected)) {
    errors.push(`${label} must include ${JSON.stringify(expected)}.`);
  }
}

function findBinding(collection, binding) {
  return Array.isArray(collection) ? collection.find((item) => item?.binding === binding) : undefined;
}

function requireBinding(collection, binding, missingMessage) {
  const bindingConfig = findBinding(collection, binding);
  if (!bindingConfig) {
    errors.push(missingMessage);
  }
  return bindingConfig;
}

function startsLocalDevServer(content) {
  return LOCAL_DEV_SERVER_COMMAND_PATTERNS.some(({ pattern }) => pattern.test(content));
}

function targetsStaging(...values) {
  return values.some((value) => STAGING_PATTERN.test(value));
}

function loadsLocalEnvFiles(content) {
  return LOCAL_ENV_FILE_PATTERN.test(content);
}

export function findWorkerRuntimeSecretErrors(config, label, guidance) {
  if (!config?.secrets) {
    return [];
  }

  return [`${label} must not declare Worker runtime secrets; ${guidance}.`];
}

export function findWorkerObservabilityErrors(config, label) {
  const observability = config?.observability;
  const requirements = [
    ['observability.enabled', observability?.enabled, true],
    ['observability.logs.enabled', observability?.logs?.enabled, true],
    ['observability.logs.head_sampling_rate', observability?.logs?.head_sampling_rate, REQUIRED_LOGS_SAMPLING_RATE],
    ['observability.traces.enabled', observability?.traces?.enabled, true],
    [
      'observability.traces.head_sampling_rate',
      observability?.traces?.head_sampling_rate,
      REQUIRED_TRACES_SAMPLING_RATE,
    ],
  ];

  return requirements
    .filter(([, actual, expected]) => actual !== expected)
    .map(
      ([path, actual, expected]) =>
        `${label} ${path} must be ${JSON.stringify(expected)}; found ${JSON.stringify(actual)}.`,
    );
}

export function findMissingWorkflowTextErrors(content, label, requiredText) {
  return requiredText
    .filter((expected) => !content.includes(expected))
    .map((expected) => `${label} must contain ${JSON.stringify(expected)}.`);
}

export function findWorkflowSequenceErrors(content, label, requiredSequence) {
  const sequenceErrors = [];
  let cursor = -1;

  for (const expected of requiredSequence) {
    const index = content.indexOf(expected, cursor + 1);
    if (index === -1) {
      sequenceErrors.push(`${label} must run ${JSON.stringify(expected)} in the production deploy sequence.`);
      continue;
    }
    cursor = index;
  }

  return sequenceErrors;
}

export function findForbiddenWorkflowCommandErrors(content, label) {
  const workflowErrors = [];
  const lines = content.split('\n');

  lines.forEach((line, index) => {
    for (const { pattern, reason } of FORBIDDEN_WORKFLOW_COMMAND_PATTERNS) {
      if (pattern.test(line)) {
        workflowErrors.push(`${label}:${index + 1} must not ${reason}.`);
      }
    }
  });

  return workflowErrors;
}

export function findMissingProvisionScriptPatternErrors(content, label, requiredPatterns) {
  return requiredPatterns
    .filter(({ pattern }) => !pattern.test(content))
    .map(({ description }) => `${label} must ${description}.`);
}

export function workflowPathsFromDirectoryEntries(entries) {
  return entries
    .filter((entry) => /\.ya?ml$/i.test(entry))
    .map((entry) => `.github/workflows/${entry}`)
    .sort();
}

function collectWorkflowPaths() {
  try {
    return workflowPathsFromDirectoryEntries(readdirSync(resolve(rootDir, '.github/workflows')));
  } catch (error) {
    errors.push(`.github/workflows must exist: ${error instanceof Error ? error.message : String(error)}.`);
    return [];
  }
}

const workerConfigTargets = [
  {
    path: 'wrangler.jsonc',
    label: 'wrangler.jsonc',
    expectedName: 'ghostbuild',
    main: 'app/server.ts',
    d1DatabaseName: 'ghostbuild',
    r2BucketName: 'ghostbuild-app-storage',
    durableObjectName: 'BuilderAgent',
    secretGuidance: 'configure runtime values as Cloudflare bindings',
    requireProvisionedD1: true,
  },
  {
    path: 'template/wrangler.jsonc',
    label: 'template/wrangler.jsonc',
    main: 'src/server.ts',
    d1DatabaseName: 'ghostbuild-cloudflare-app',
    r2BucketName: 'ghostbuild-cloudflare-app-storage',
    durableObjectName: 'AppAgent',
    secretGuidance: 'generated apps should configure runtime values as Cloudflare bindings',
    requireProvisionedD1: false,
  },
];

const packageConfigTargets = [
  {
    path: 'package.json',
    label: 'package.json',
    requiredScripts: [
      ['deploy', 'pnpm run deploy:production'],
      [
        'deploy:production',
        'pnpm run verify:stack && pnpm run verify:template && pnpm run typecheck && pnpm run provision:production && pnpm run verify:production-config && pnpm run build && pnpm run lint && pnpm run test && pnpm run knip && pnpm run d1:migrations:apply:production && wrangler deploy',
      ],
      ['d1:migrations:apply:production', 'wrangler d1 migrations apply ghostbuild --remote'],
      ['provision:production', 'node scripts/provision-cloudflare-production.mjs'],
      ['verify:stack', 'node scripts/verify-stack-alignment.mjs'],
      [
        'verify:template',
        'pnpm --dir template run verify:stack && pnpm --dir template run verify:production-config -- --allow-unprovisioned && pnpm --dir template run typecheck && pnpm --dir template run lint && pnpm --dir template run build && pnpm --dir template exec wrangler deploy --dry-run',
      ],
      ['verify:production-config', 'node scripts/verify-production-config.mjs'],
    ],
    requiredDevDependencies: [
      {
        name: 'jsonc-parser',
        purpose: 'production config verification',
      },
    ],
  },
  {
    path: 'template/package.json',
    label: 'template/package.json',
    requiredScripts: [
      [
        'deploy',
        'pnpm run verify:stack && pnpm run typecheck && pnpm run provision:production && pnpm run verify:production-config && pnpm run build && pnpm run lint && pnpm run d1:migrations:apply:production && wrangler deploy',
      ],
      ['typecheck', 'pnpm run generate-routes && pnpm run cf-typegen && tsc -p . --noEmit --pretty false'],
      ['provision:production', 'node scripts/provision-cloudflare-production.mjs'],
      ['verify:stack', 'node scripts/verify-stack-alignment.mjs'],
      ['verify:production-config', 'node scripts/verify-production-config.mjs'],
      ['lint', 'eslint src vite.config.ts --max-warnings=0'],
    ],
    requiredDevDependencies: [
      {
        name: 'jsonc-parser',
        purpose: 'production config verification',
      },
      {
        name: 'eslint',
        purpose: 'production linting',
      },
      {
        name: 'typescript-eslint',
        purpose: 'production linting',
      },
    ],
  },
];
const provisionScriptTargets = [
  'scripts/provision-cloudflare-production.mjs',
  'template/scripts/provision-cloudflare-production.mjs',
].map((path) => ({ path, label: path }));

function verifyWorkerConfig(config, target) {
  const { label, expectedName, main, d1DatabaseName, r2BucketName, durableObjectName, secretGuidance } = target;

  if (expectedName) {
    requireEqual(`${label} name`, config?.name, expectedName);
  }
  requireEqual(`${label} main`, config?.main, main);
  requireEqual(`${label} compatibility_date`, config?.compatibility_date, REQUIRED_COMPATIBILITY_DATE);
  requireArrayIncludes(`${label} compatibility_flags`, config?.compatibility_flags, 'nodejs_compat');
  errors.push(...findWorkerObservabilityErrors(config, label));
  requireEqual(`${label} upload_source_maps`, config?.upload_source_maps, true);
  requireEqual(`${label} ai.binding`, config?.ai?.binding, 'AI');
  errors.push(...findWorkerRuntimeSecretErrors(config, label, secretGuidance));

  const d1 = requireBinding(config?.d1_databases, 'DB', `${label} must bind D1 as DB.`);
  if (d1) {
    requireEqual(`${label} D1 database_name`, d1.database_name, d1DatabaseName);
    requireEqual(`${label} D1 migrations_dir`, d1.migrations_dir, 'migrations');
    if (target.requireProvisionedD1 && (!d1.database_id || d1.database_id === PLACEHOLDER_D1_ID)) {
      errors.push('Replace the placeholder D1 database_id in wrangler.jsonc before production deploy.');
    }
  }

  const r2 = requireBinding(config?.r2_buckets, 'APP_STORAGE', `${label} must bind R2 as APP_STORAGE.`);
  if (r2) {
    requireEqual(`${label} R2 bucket_name`, r2.bucket_name, r2BucketName);
  }

  const durableObject = config?.durable_objects?.bindings?.find((item) => item?.name === durableObjectName);
  if (!durableObject) {
    errors.push(`${label} must bind the ${durableObjectName} Durable Object.`);
  } else {
    requireEqual(`${label} ${durableObjectName} class_name`, durableObject.class_name, durableObjectName);
  }

  const hasDurableObjectMigration = Array.isArray(config?.migrations)
    ? config.migrations.some((migration) => migration?.new_sqlite_classes?.includes(durableObjectName))
    : false;
  if (!hasDurableObjectMigration) {
    errors.push(`${label} must include a SQLite Durable Object migration for ${durableObjectName}.`);
  }
}

function verifyNoLocalOrStagingScripts(label, scripts) {
  if (!scripts || typeof scripts !== 'object') {
    errors.push(`${label} scripts must be configured.`);
    return;
  }

  for (const name of FORBIDDEN_PRODUCTION_SCRIPT_NAMES) {
    if (scripts[name]) {
      errors.push(`${label} must not define ${JSON.stringify(name)}; deploy directly to production Cloudflare.`);
    }
  }

  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== 'string') {
      continue;
    }
    if (startsLocalDevServer(command)) {
      errors.push(`${label} script ${JSON.stringify(name)} must not start a local dev server.`);
    }
    if (targetsStaging(name, command)) {
      errors.push(`${label} script ${JSON.stringify(name)} must not target staging.`);
    }
    if (loadsLocalEnvFiles(command)) {
      errors.push(`${label} script ${JSON.stringify(name)} must not load local env files.`);
    }
  }
}

function verifyPackageConfig(config, target) {
  const { label, requiredScripts, requiredDevDependencies } = target;

  for (const [name, command] of requiredScripts) {
    requireEqual(`${label} scripts.${name}`, config?.scripts?.[name], command);
  }

  for (const { name, purpose } of requiredDevDependencies) {
    if (!config?.devDependencies?.[name]) {
      errors.push(`${label} must include ${name} for ${purpose}.`);
    }
  }

  verifyNoLocalOrStagingScripts(label, config?.scripts);
}

function verifyProvisionScript(path, label) {
  const content = readTextConfig(path, label);
  if (!content) {
    return;
  }

  errors.push(...findMissingProvisionScriptPatternErrors(content, label, REQUIRED_PROVISION_SCRIPT_PATTERNS));

  if (startsLocalDevServer(content)) {
    errors.push(`${label} must not start local dev servers.`);
  }

  if (targetsStaging(content)) {
    errors.push(`${label} must not target staging.`);
  }

  if (loadsLocalEnvFiles(content)) {
    errors.push(`${label} must not load local env files.`);
  }
}

function verifyWorkflowConfig() {
  const workflowsByPath = new Map();

  for (const path of collectWorkflowPaths()) {
    const workflow = readTextConfig(path, path);
    if (!workflow) {
      continue;
    }
    workflowsByPath.set(path, workflow);
    errors.push(...findForbiddenWorkflowCommandErrors(workflow, path));
  }

  const deployWorkflow =
    workflowsByPath.get('.github/workflows/deploy.yml') ??
    readTextConfig('.github/workflows/deploy.yml', '.github/workflows/deploy.yml');
  if (deployWorkflow) {
    errors.push(
      ...findMissingWorkflowTextErrors(deployWorkflow, '.github/workflows/deploy.yml', REQUIRED_DEPLOY_WORKFLOW_TEXT),
    );
    errors.push(
      ...findWorkflowSequenceErrors(deployWorkflow, '.github/workflows/deploy.yml', REQUIRED_DEPLOY_WORKFLOW_SEQUENCE),
    );
  }

  for (const path of ['.github/workflows/ci.yml', '.github/workflows/e2e.yml']) {
    const workflow = workflowsByPath.get(path) ?? readTextConfig(path, path);
    if (!workflow) {
      continue;
    }
    errors.push(...findMissingWorkflowTextErrors(workflow, path, REQUIRED_VERIFICATION_WORKFLOW_TEXT));
  }
}

export function verifyProductionConfig() {
  errors.length = 0;
  for (const target of workerConfigTargets) {
    verifyWorkerConfig(readJsoncConfig(target.path, target.label), target);
  }
  for (const target of packageConfigTargets) {
    verifyPackageConfig(readJsonConfig(target.path, target.label), target);
  }
  for (const target of provisionScriptTargets) {
    verifyProvisionScript(target.path, target.label);
  }
  verifyWorkflowConfig();

  return [...errors];
}

export function main() {
  const productionErrors = verifyProductionConfig();
  if (productionErrors.length > 0) {
    console.error(productionErrors.map((error) => `- ${error}`).join('\n'));
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
