import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyGlobalDeployment, verifyLocalDeployment } from './verify-live-deployment.mjs';

const CLIENT_ID_ENV = 'CLOUDFLARE_OAUTH_CLIENT_ID';
const MAX_CLIENT_ID_LENGTH = 512;
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const WORKERS_BUILD_UUID_PATTERN = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

/**
 * @typedef {(command: string, args: readonly string[], options: {stdio: 'inherit'}) => {
 *   error?: Error;
 *   status?: number | null;
 * }} DeploySpawn
 */

export function validateOAuthClientId(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${CLIENT_ID_ENV} must be configured as a non-secret deploy environment variable.`);
  }
  if (value.length > MAX_CLIENT_ID_LENGTH) {
    throw new Error(`${CLIENT_ID_ENV} must be at most ${MAX_CLIENT_ID_LENGTH} characters.`);
  }
  if (!/^[A-Za-z0-9._~-]+$/.test(value)) {
    throw new Error(`${CLIENT_ID_ENV} may contain only letters, digits, dots, underscores, tildes, and hyphens.`);
  }
  return value;
}

export function validateCommitSha(value) {
  if (typeof value !== 'string' || !COMMIT_SHA_PATTERN.test(value)) {
    throw new Error('The production commit SHA must be the exact lowercase 40-hex Git commit ID.');
  }
  return value;
}

/**
 * @param {{spawn?: typeof spawnSync}} [options]
 */
export function resolveCurrentCommitSha({ spawn = spawnSync } = {}) {
  const result = spawn('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    throw new Error(`Unable to resolve the current Git commit${detail ? `: ${detail}` : '.'}`);
  }
  return validateCommitSha(typeof result.stdout === 'string' ? result.stdout.trim() : '');
}

/**
 * @param {{
 *   env?: Record<string, string | undefined>;
 *   spawn?: typeof spawnSync;
 *   currentCommitSha?: string;
 * }} [options]
 */
export function validateWorkersBuildContext({ env = process.env, spawn = spawnSync, currentCommitSha } = {}) {
  const { branch, commitSha } = validateWorkersBuildMetadata({ env, spawn, currentCommitSha });
  if (branch !== 'main') {
    throw new Error(`Cloudflare production deploy requires the main branch; found ${branch}.`);
  }
  return commitSha;
}

/**
 * @param {{
 *   env?: Record<string, string | undefined>;
 *   spawn?: typeof spawnSync;
 *   currentCommitSha?: string;
 * }} [options]
 */
export function validateWorkersBuildMetadata({ env = process.env, spawn = spawnSync, currentCommitSha } = {}) {
  if (env.WORKERS_CI !== '1') {
    throw new Error('Cloudflare Workers Builds requires WORKERS_CI=1.');
  }
  const branch = env.WORKERS_CI_BRANCH;
  if (
    typeof branch !== 'string' ||
    branch.length === 0 ||
    branch.length > 255 ||
    /[\u0000-\u001f\u007f]/.test(branch)
  ) {
    throw new Error('WORKERS_CI_BRANCH must be a non-empty Git branch name without control characters.');
  }
  const buildCommitSha = validateCommitSha(env.WORKERS_CI_COMMIT_SHA);
  const checkoutCommitSha = currentCommitSha ?? resolveCurrentCommitSha({ spawn });
  if (buildCommitSha !== checkoutCommitSha) {
    throw new Error(
      `Workers Builds commit ${buildCommitSha} does not match the checked-out commit ${checkoutCommitSha}.`,
    );
  }
  if (typeof env.WORKERS_CI_BUILD_UUID !== 'string' || !WORKERS_BUILD_UUID_PATTERN.test(env.WORKERS_CI_BUILD_UUID)) {
    throw new Error('WORKERS_CI_BUILD_UUID must be a lowercase UUID.');
  }
  return { branch, commitSha: buildCommitSha };
}

/**
 * Resolve a commit that exactly describes the files being deployed. Tracked or
 * untracked changes would make COMMIT_SHA misleading, so production fails closed.
 * @param {{spawn?: typeof spawnSync, env?: Record<string, string | undefined>}} [options]
 */
export function resolveDeployableCommitSha({ spawn = spawnSync, env = process.env } = {}) {
  const commitSha = resolveCurrentCommitSha({ spawn });
  validateWorkersBuildContext({ env, spawn, currentCommitSha: commitSha });
  const result = spawn('git', ['status', '--porcelain=v1', '--untracked-files=normal'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    throw new Error(`Unable to verify the production worktree${detail ? `: ${detail}` : '.'}`);
  }
  if (typeof result.stdout !== 'string' || result.stdout.trim().length > 0) {
    throw new Error('Production deploy requires a clean Git worktree so COMMIT_SHA exactly identifies the build.');
  }
  const ignoredEnvironmentFiles = spawn(
    'git',
    [
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '-z',
      '--',
      ':(top).env',
      ':(top).env.*',
      ':(top).dev.vars',
      ':(top).dev.vars*',
      ':(top)*.vars',
    ],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (ignoredEnvironmentFiles.error) {
    throw ignoredEnvironmentFiles.error;
  }
  if (ignoredEnvironmentFiles.status !== 0) {
    const detail = typeof ignoredEnvironmentFiles.stderr === 'string' ? ignoredEnvironmentFiles.stderr.trim() : '';
    throw new Error(`Unable to inspect ignored production environment files${detail ? `: ${detail}` : '.'}`);
  }
  if (typeof ignoredEnvironmentFiles.stdout !== 'string' || ignoredEnvironmentFiles.stdout.length > 0) {
    throw new Error(
      'Production deploy refuses ignored root .env*, .dev.vars*, and *.vars files because Vite or Wrangler could make the build differ from COMMIT_SHA.',
    );
  }
  return commitSha;
}

export function wranglerDeployArgs(clientId, commitSha) {
  return [
    'exec',
    'wrangler',
    'deploy',
    '--var',
    `COMMIT_SHA:${validateCommitSha(commitSha)}`,
    '--var',
    `${CLIENT_ID_ENV}:${validateOAuthClientId(clientId)}`,
  ];
}

/**
 * @param {{
 *   clientId?: string;
 *   commitSha?: string;
 *   env?: Record<string, string | undefined>;
 *   spawn?: DeploySpawn;
 * }} [options]
 */
export function deployProduction({
  clientId = process.env[CLIENT_ID_ENV],
  commitSha,
  env = process.env,
  spawn = spawnSync,
} = {}) {
  commitSha =
    commitSha === undefined
      ? resolveDeployableCommitSha({ spawn, env })
      : validateWorkersBuildContext({ env, spawn, currentCommitSha: validateCommitSha(commitSha) });
  const args = wranglerDeployArgs(clientId, commitSha);
  const result = spawn('pnpm', args, { stdio: 'inherit' });
  if (result.error) {
    throw result.error;
  }
  if (typeof result.status !== 'number') {
    throw new Error('Wrangler deploy terminated without an exit status.');
  }
  if (result.status !== 0) {
    throw new Error(`Wrangler deploy failed with exit status ${result.status}. Live verification was not run.`);
  }
  return validateCommitSha(commitSha);
}

/**
 * @param {{
 *   clientId?: string;
 *   commitSha?: string;
 *   env?: Record<string, string | undefined>;
 *   spawn?: DeploySpawn;
 *   verifyLocal?: typeof verifyLocalDeployment;
 *   verifyGlobal?: typeof verifyGlobalDeployment;
 * }} [options]
 */
export async function deployAndVerifyProduction({
  clientId = process.env[CLIENT_ID_ENV],
  commitSha,
  env = process.env,
  spawn = spawnSync,
  verifyLocal = verifyLocalDeployment,
  verifyGlobal = verifyGlobalDeployment,
} = {}) {
  const deployedSha = deployProduction({ clientId, commitSha, env, spawn });
  await verifyLocal({ expectedSha: deployedSha });
  await verifyGlobal({ expectedSha: deployedSha });
  return deployedSha;
}

function isMainModule() {
  return (
    Boolean(process.argv[1]) &&
    pathToFileURL(resolve(process.argv[1])).href === pathToFileURL(fileURLToPath(import.meta.url)).href
  );
}

if (isMainModule()) {
  const main = async () => {
    const [command, ...extraArgs] = process.argv.slice(2);
    if (extraArgs.length > 0 || (command !== undefined && command !== '--check-workers-builds')) {
      throw new Error('Usage: node scripts/deploy-production.mjs [--check-workers-builds]');
    }
    const clientId = validateOAuthClientId(process.env[CLIENT_ID_ENV]);
    const commitSha = resolveDeployableCommitSha();
    if (command === '--check-workers-builds') {
      console.log(`Production deploy inputs are valid for commit ${commitSha}.`);
      return;
    }
    await deployAndVerifyProduction({ clientId, commitSha });
  };

  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
