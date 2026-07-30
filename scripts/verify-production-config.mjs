import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, printParseErrorCode } from 'jsonc-parser';
import {
  findBuildApprovalErrors,
  findMissingCommandSteps,
  findMissingProvisionScriptPatternErrors,
  findWorkerObservabilityErrors,
  findWorkerRuntimeSecretErrors,
  loadsLocalEnvFiles,
  startsLocalDevServer,
  targetsStaging,
  workflowPathsFromDirectoryEntries,
} from '../template/scripts/lib/project-policy.mjs';
import { runVerifierIfMain } from './run-verifier.mjs';

export {
  findBuildApprovalErrors,
  findMissingProvisionScriptPatternErrors,
  findWorkerObservabilityErrors,
  findWorkerRuntimeSecretErrors,
  workflowPathsFromDirectoryEntries,
};

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED_COMPATIBILITY_DATE = '2026-07-21';
const REQUIRED_OAUTH_SCOPES =
  'account-settings.read user-details.read workers-scripts.write d1.write workers-r2.write ai.read';
const REQUIRED_SECRET_NAMES = [
  'CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY',
  'CLOUDFLARE_OAUTH_CLIENT_SECRET',
  'DEPLOYMENT_PROXY_JWT_SECRET',
];
const PLACEHOLDER_D1_ID = '00000000-0000-0000-0000-000000000000';
const workerTargets = [
  {
    path: 'wrangler.jsonc',
    name: 'ghostbuild',
    main: 'app/server.ts',
    databaseName: 'ghostbuild',
    bucketName: 'ghostbuild-app-storage',
    durableObjects: ['BuilderAgent', 'DeploymentSandbox'],
    customDomain: 'ghostbuild.dev',
    allowPlaceholderDatabase: false,
  },
];

function readJson(path, errors) {
  try {
    return JSON.parse(readFileSync(resolve(rootDir, path), 'utf8'));
  } catch (error) {
    errors.push(`${path} must be valid JSON: ${error instanceof Error ? error.message : String(error)}.`);
    return undefined;
  }
}

function readJsonc(path, errors) {
  const parseErrors = [];
  const config = parse(readFileSync(resolve(rootDir, path), 'utf8'), parseErrors, { allowTrailingComma: true });
  for (const error of parseErrors) {
    errors.push(`${path} has invalid JSONC: ${printParseErrorCode(error.error)} at offset ${error.offset}.`);
  }
  return config;
}

function requireEqual(errors, label, actual, expected) {
  if (actual !== expected) {
    errors.push(`${label} must be ${JSON.stringify(expected)}; found ${JSON.stringify(actual)}.`);
  }
}

function findBinding(collection, binding) {
  return Array.isArray(collection) ? collection.find((item) => item?.binding === binding) : undefined;
}

function findNamedBinding(collection, name) {
  return Array.isArray(collection) ? collection.find((item) => item?.name === name) : undefined;
}

export function findWorkerRoutingErrors(config, label, customDomain) {
  const errors = [];
  if (config?.workers_dev !== false) {
    errors.push(`${label} workers_dev must be false so production is served only from the custom domain.`);
  }
  const customRoute = Array.isArray(config?.routes)
    ? config.routes.find((route) => route?.pattern === customDomain && route?.custom_domain === true)
    : undefined;
  if (!customRoute) {
    errors.push(`${label} must configure ${JSON.stringify(customDomain)} as a custom domain.`);
  }
  return errors;
}

export function findWorkerVariableSourceErrors(config, label) {
  const errors = [];
  if (Object.hasOwn(config ?? {}, 'keep_vars')) {
    errors.push(`${label} must omit keep_vars so checked-in config and deploy arguments remain the source of truth.`);
  }
  if (Object.hasOwn(config?.vars ?? {}, 'CLOUDFLARE_OAUTH_CLIENT_ID')) {
    errors.push(`${label} must not commit CLOUDFLARE_OAUTH_CLIENT_ID; inject it from the deploy environment.`);
  }
  return errors;
}

export function findWorkerTelemetryRateLimitErrors(config, label) {
  const errors = [];
  const binding = findNamedBinding(config?.ratelimits, 'CLIENT_TELEMETRY_RATE_LIMITER');
  if (!binding) {
    return [`${label} must bind CLIENT_TELEMETRY_RATE_LIMITER.`];
  }
  if (!/^\d+$/.test(binding.namespace_id ?? '') || Number(binding.namespace_id) < 1) {
    errors.push(`${label} telemetry rate-limit namespace_id must be a positive integer string.`);
  }
  requireEqual(errors, `${label} telemetry rate-limit simple.limit`, binding.simple?.limit, 30);
  requireEqual(errors, `${label} telemetry rate-limit simple.period`, binding.simple?.period, 60);
  return errors;
}

export function findWorkerOAuthStartRateLimitErrors(config, label) {
  const errors = [];
  const binding = findNamedBinding(config?.ratelimits, 'CLOUDFLARE_OAUTH_START_RATE_LIMITER');
  if (!binding) {
    return [`${label} must bind CLOUDFLARE_OAUTH_START_RATE_LIMITER.`];
  }
  requireEqual(errors, `${label} OAuth-start rate-limit namespace_id`, binding.namespace_id, '1002');
  requireEqual(errors, `${label} OAuth-start rate-limit simple.limit`, binding.simple?.limit, 10);
  requireEqual(errors, `${label} OAuth-start rate-limit simple.period`, binding.simple?.period, 60);
  return errors;
}

export function findWorkerChatBackupQuotaErrors(config, label) {
  const errors = [];
  const binding = findNamedBinding(config?.ratelimits, 'CHAT_BACKUP_RATE_LIMITER');
  if (!binding) {
    errors.push(`${label} must bind CHAT_BACKUP_RATE_LIMITER.`);
  } else {
    requireEqual(errors, `${label} chat-backup rate-limit namespace_id`, binding.namespace_id, '1003');
    requireEqual(errors, `${label} chat-backup rate-limit simple.limit`, binding.simple?.limit, 240);
    requireEqual(errors, `${label} chat-backup rate-limit simple.period`, binding.simple?.period, 60);
  }
  if (!['shadow', 'enforce'].includes(config?.vars?.CHAT_BACKUP_STORAGE_QUOTA_MODE)) {
    errors.push(`${label} vars.CHAT_BACKUP_STORAGE_QUOTA_MODE must be "shadow" or "enforce".`);
  }
  requireEqual(
    errors,
    `${label} vars.CHAT_BACKUP_STORAGE_LIMIT_BYTES`,
    config?.vars?.CHAT_BACKUP_STORAGE_LIMIT_BYTES,
    '1073741824',
  );
  requireEqual(
    errors,
    `${label} vars.CHAT_BACKUP_STORAGE_LIMIT_OBJECTS`,
    config?.vars?.CHAT_BACKUP_STORAGE_LIMIT_OBJECTS,
    '4096',
  );
  requireEqual(
    errors,
    `${label} vars.CHAT_BACKUP_REQUESTS_PER_MINUTE`,
    config?.vars?.CHAT_BACKUP_REQUESTS_PER_MINUTE,
    '120',
  );
  requireEqual(
    errors,
    `${label} vars.CHAT_BACKUP_REQUESTS_PER_DAY`,
    config?.vars?.CHAT_BACKUP_REQUESTS_PER_DAY,
    '10000',
  );
  return errors;
}

export function findWorkerGcScheduleErrors(config, label) {
  return config?.triggers?.crons?.includes('*/15 * * * *')
    ? []
    : [`${label} must schedule the bounded deferred-data GC sweep every 15 minutes.`];
}

export function findSkillSyncWorkflowErrors(config, label) {
  const workflow = findBinding(config?.workflows, 'SkillSyncWorkflow');
  if (!workflow) {
    return [`${label} must bind the weekly SkillSyncWorkflow.`];
  }
  const errors = [];
  requireEqual(errors, `${label} SkillSyncWorkflow name`, workflow.name, 'ghostbuild-skill-sync');
  requireEqual(errors, `${label} SkillSyncWorkflow class_name`, workflow.class_name, 'SkillSyncWorkflow');
  if (!Array.isArray(workflow.schedules) || !workflow.schedules.includes('0 8 * * 1')) {
    errors.push(`${label} must schedule SkillSyncWorkflow weekly at 08:00 UTC on Monday.`);
  }
  return errors;
}

export function findDurableObjectLifecycleErrors(config, label, classNames) {
  const errors = [];
  if (Object.hasOwn(config ?? {}, 'migrations')) {
    errors.push(`${label} must use declarative exports instead of the legacy Durable Object migrations flow.`);
  }
  for (const className of classNames) {
    const binding = config?.durable_objects?.bindings?.find((item) => item?.class_name === className);
    if (!binding) {
      errors.push(`${label} must bind the ${className} Durable Object.`);
    }
    const lifecycle = config?.exports?.[className];
    if (lifecycle?.type !== 'durable-object' || lifecycle?.storage !== 'sqlite') {
      errors.push(`${label} must declare the ${className} Durable Object as a live SQLite export.`);
    }
  }
  return errors;
}

function verifyWorker(errors, config, target) {
  const label = target.path;
  requireEqual(errors, `${label} name`, config?.name, target.name);
  requireEqual(errors, `${label} main`, config?.main, target.main);
  requireEqual(errors, `${label} compatibility_date`, config?.compatibility_date, REQUIRED_COMPATIBILITY_DATE);
  if (!config?.compatibility_flags?.includes('nodejs_compat')) {
    errors.push(`${label} compatibility_flags must include "nodejs_compat".`);
  }
  requireEqual(errors, `${label} upload_source_maps`, config?.upload_source_maps, true);
  requireEqual(errors, `${label} version_metadata.binding`, config?.version_metadata?.binding, 'CF_VERSION_METADATA');
  errors.push(...findWorkerTelemetryRateLimitErrors(config, label));
  errors.push(...findWorkerOAuthStartRateLimitErrors(config, label));
  errors.push(...findWorkerChatBackupQuotaErrors(config, label));
  requireEqual(
    errors,
    `${label} vars.CLOUDFLARE_OAUTH_SCOPES`,
    config?.vars?.CLOUDFLARE_OAUTH_SCOPES,
    REQUIRED_OAUTH_SCOPES,
  );
  errors.push(
    ...findWorkerObservabilityErrors(config, label),
    ...findWorkerRoutingErrors(config, label, target.customDomain),
    ...findWorkerVariableSourceErrors(config, label),
    ...findWorkerGcScheduleErrors(config, label),
    ...findSkillSyncWorkflowErrors(config, label),
    ...findDurableObjectLifecycleErrors(config, label, target.durableObjects),
    ...findWorkerRuntimeSecretErrors(config, label, 'configure values as Cloudflare bindings'),
  );
  const configuredSecretNames = config?.secrets?.required;
  if (Array.isArray(configuredSecretNames)) {
    for (const secretName of REQUIRED_SECRET_NAMES) {
      if (!configuredSecretNames.includes(secretName)) {
        errors.push(`${label} secrets.required must include ${JSON.stringify(secretName)}.`);
      }
    }
  } else {
    errors.push(`${label} secrets.required must declare the production Worker secret names.`);
  }

  const d1 = findBinding(config?.d1_databases, 'DB');
  if (!d1) {
    errors.push(`${label} must bind D1 as DB.`);
  } else {
    requireEqual(errors, `${label} D1 database_name`, d1.database_name, target.databaseName);
    requireEqual(errors, `${label} D1 migrations_dir`, d1.migrations_dir, 'migrations');
    if (!target.allowPlaceholderDatabase && (!d1.database_id || d1.database_id === PLACEHOLDER_D1_ID)) {
      errors.push(`${label} must contain a provisioned D1 database_id.`);
    }
  }

  const r2 = findBinding(config?.r2_buckets, 'APP_STORAGE');
  if (!r2) {
    errors.push(`${label} must bind R2 as APP_STORAGE.`);
  } else {
    requireEqual(errors, `${label} R2 bucket_name`, r2.bucket_name, target.bucketName);
  }
}

function verifyScripts(errors, pkg, label) {
  const scripts = pkg?.scripts;
  if (!scripts || typeof scripts !== 'object') {
    errors.push(`${label} scripts must be configured.`);
    return;
  }
  const requiredNames = [
    'build',
    'd1:bookmark:production',
    'workers-builds:build',
    'workers-builds:deploy',
    'workers-builds:preview',
    'provision:production',
    'provision:production:check',
    'typecheck',
    'validate',
    'validate:agent',
    'validate:root',
    'validate:template',
    'verify:production-config',
    'verify:workers-builds-config',
    'verify:licenses',
    'verify:static-assets',
    'verify:stack',
  ];
  for (const name of requiredNames) {
    if (typeof scripts[name] !== 'string') {
      errors.push(`${label} must define scripts.${name}.`);
    }
  }

  errors.push(
    ...findMissingCommandSteps(scripts['workers-builds:deploy'], `${label} Workers Builds deploy script`, [
      'scripts/deploy-production.mjs --check-workers-builds',
      'provision:production:check',
      'verify:production-config',
      'verify:workers-builds-config',
      'd1:bookmark:production',
      'd1:migrations:apply:production',
      'scripts/deploy-production.mjs',
    ]),
  );
  errors.push(
    ...findMissingCommandSteps(scripts['workers-builds:build'], `${label} Workers Builds build script`, [
      'pnpm install --frozen-lockfile',
      'scripts/check-workers-builds-environment.mjs',
      'validate',
      'git diff --exit-code',
    ]),
  );

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

function verifyProvisionScript(errors, path) {
  const result = spawnSync(process.execPath || process.argv0 || 'node', [resolve(rootDir, path), '--dry-run'], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    errors.push(`${path} --dry-run must succeed: ${(result.stderr || result.stdout).trim()}.`);
  }
}

function verifyWorkflows(errors) {
  const workflowsDirectory = resolve(rootDir, '.github/workflows');
  const workflowPaths = existsSync(workflowsDirectory)
    ? workflowPathsFromDirectoryEntries(readdirSync(workflowsDirectory))
    : [];
  for (const path of workflowPaths) {
    errors.push(`${path} must not exist; Cloudflare Workers Builds is the only CI/CD provider.`);
  }

  const setupActionPath = '.github/actions/setup-and-build/action.yaml';
  if (existsSync(resolve(rootDir, setupActionPath))) {
    errors.push(`${setupActionPath} must not exist; Cloudflare's build image owns CI toolchain setup.`);
  }
}

export function verifyProductionConfig() {
  const errors = [];
  for (const target of workerTargets) {
    verifyWorker(errors, readJsonc(target.path, errors), target);
  }
  verifyScripts(errors, readJson('package.json', errors), 'package.json');
  verifyProvisionScript(errors, 'scripts/provision-cloudflare-production.mjs');
  verifyWorkflows(errors);
  return errors;
}

runVerifierIfMain(import.meta.url, verifyProductionConfig);
