import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, printParseErrorCode } from 'jsonc-parser';
import {
  findForbiddenWorkflowCommandErrors,
  findMissingCommandSteps,
  findMissingProvisionScriptPatternErrors,
  findMissingWorkflowTextErrors,
  findWorkerObservabilityErrors,
  findWorkerRuntimeSecretErrors,
  findWorkflowSequenceErrors,
  loadsLocalEnvFiles,
  startsLocalDevServer,
  targetsStaging,
  workflowPathsFromDirectoryEntries,
} from '../template/scripts/lib/project-policy.mjs';
import { runVerifierIfMain } from './run-verifier.mjs';

export {
  findForbiddenWorkflowCommandErrors,
  findMissingProvisionScriptPatternErrors,
  findMissingWorkflowTextErrors,
  findWorkerObservabilityErrors,
  findWorkerRuntimeSecretErrors,
  findWorkflowSequenceErrors,
  workflowPathsFromDirectoryEntries,
};

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED_COMPATIBILITY_DATE = '2026-07-08';
const PLACEHOLDER_D1_ID = '00000000-0000-0000-0000-000000000000';
const workerTargets = [
  {
    path: 'wrangler.jsonc',
    name: 'ghostbuild',
    main: 'app/server.ts',
    databaseName: 'ghostbuild',
    bucketName: 'ghostbuild-app-storage',
    durableObject: 'BuilderAgent',
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

function verifyWorker(errors, config, target) {
  const label = target.path;
  requireEqual(errors, `${label} name`, config?.name, target.name);
  requireEqual(errors, `${label} main`, config?.main, target.main);
  requireEqual(errors, `${label} compatibility_date`, config?.compatibility_date, REQUIRED_COMPATIBILITY_DATE);
  if (!config?.compatibility_flags?.includes('nodejs_compat')) {
    errors.push(`${label} compatibility_flags must include "nodejs_compat".`);
  }
  requireEqual(errors, `${label} upload_source_maps`, config?.upload_source_maps, true);
  errors.push(
    ...findWorkerObservabilityErrors(config, label),
    ...findWorkerRoutingErrors(config, label, target.customDomain),
    ...findWorkerRuntimeSecretErrors(config, label, 'configure values as Cloudflare bindings'),
  );

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

  const durableObject = config?.durable_objects?.bindings?.find(
    (binding) => binding?.class_name === target.durableObject,
  );
  if (!durableObject) {
    errors.push(`${label} must bind the ${target.durableObject} Durable Object.`);
  }
  const migration = config?.migrations?.some((item) => item?.new_sqlite_classes?.includes(target.durableObject));
  if (!migration) {
    errors.push(`${label} must migrate the ${target.durableObject} SQLite Durable Object.`);
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
    'deploy:production',
    'provision:production',
    'typecheck',
    'validate',
    'validate:agent',
    'validate:root',
    'validate:template',
    'verify:production-config',
    'verify:stack',
  ];
  for (const name of requiredNames) {
    if (typeof scripts[name] !== 'string') {
      errors.push(`${label} must define scripts.${name}.`);
    }
  }

  const deployScript = scripts['deploy:production'];
  errors.push(
    ...findMissingCommandSteps(deployScript, `${label} production deploy script`, [
      'validate',
      'provision:production',
      'verify:production-config',
      'd1:migrations:apply:production',
      'wrangler deploy',
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
  const workflowPaths = workflowPathsFromDirectoryEntries(readdirSync(resolve(rootDir, '.github/workflows')));
  const workflows = new Map();
  for (const path of workflowPaths) {
    const content = readFileSync(resolve(rootDir, path), 'utf8');
    workflows.set(path, content);
    errors.push(...findForbiddenWorkflowCommandErrors(content, path));
  }

  const deploy = workflows.get('.github/workflows/deploy.yml') ?? '';
  errors.push(
    ...findMissingWorkflowTextErrors(deploy, '.github/workflows/deploy.yml', [
      'name: Production Deploy',
      'branches:',
      '- main',
      'environment:',
      'name: production',
      'CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}',
      'CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}',
      'uses: cloudflare/wrangler-action@v4',
      'apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}',
      'accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}',
      'packageManager: pnpm',
      'command: deploy --var COMMIT_SHA:${{ github.sha }}',
      'name: Verify live deployment version',
      'EXPECTED_SHA: ${{ github.sha }}',
      'https://ghostbuild.dev/api/version',
    ]),
    ...findWorkflowSequenceErrors(deploy, '.github/workflows/deploy.yml', [
      'pnpm run validate',
      'pnpm run provision:production',
      'pnpm run verify:production-config',
      'pnpm run d1:migrations:apply:production',
      'uses: cloudflare/wrangler-action@v4',
      'command: deploy --var COMMIT_SHA:${{ github.sha }}',
      'name: Verify live deployment version',
    ]),
  );
  errors.push(
    ...findMissingWorkflowTextErrors(workflows.get('.github/workflows/ci.yml') ?? '', '.github/workflows/ci.yml', [
      'pnpm run validate',
      'workflow_dispatch:',
    ]),
  );
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
