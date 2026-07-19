import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CLIENT_ID_ENV = 'CLOUDFLARE_OAUTH_CLIENT_ID';
const MAX_CLIENT_ID_LENGTH = 512;

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

export function wranglerDeployArgs(clientId) {
  return ['exec', 'wrangler', 'deploy', '--var', `${CLIENT_ID_ENV}:${validateOAuthClientId(clientId)}`];
}

/**
 * @param {{clientId?: string, spawn?: DeploySpawn}} [options]
 */
export function deployProduction({ clientId = process.env[CLIENT_ID_ENV], spawn = spawnSync } = {}) {
  const args = wranglerDeployArgs(clientId);
  const result = spawn('pnpm', args, { stdio: 'inherit' });
  if (result.error) {
    throw result.error;
  }
  if (typeof result.status !== 'number') {
    throw new Error('Wrangler deploy terminated without an exit status.');
  }
  return result.status;
}

function isMainModule() {
  return (
    Boolean(process.argv[1]) &&
    pathToFileURL(resolve(process.argv[1])).href === pathToFileURL(fileURLToPath(import.meta.url)).href
  );
}

if (isMainModule()) {
  try {
    const [command, ...extraArgs] = process.argv.slice(2);
    if (extraArgs.length > 0 || (command !== undefined && command !== '--check')) {
      throw new Error('Usage: node scripts/deploy-production.mjs [--check]');
    }
    const clientId = validateOAuthClientId(process.env[CLIENT_ID_ENV]);
    if (command !== '--check') {
      process.exitCode = deployProduction({ clientId });
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
