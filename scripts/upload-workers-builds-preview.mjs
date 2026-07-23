import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolveCurrentCommitSha, validateOAuthClientId, validateWorkersBuildMetadata } from './deploy-production.mjs';

/**
 * @param {{
 *   env?: Record<string, string | undefined>;
 *   spawn?: typeof spawnSync;
 *   currentCommitSha?: string;
 * }} [options]
 */
export function validatePreviewBuildContext({ env = process.env, spawn = spawnSync, currentCommitSha } = {}) {
  const metadata = validateWorkersBuildMetadata({ env, spawn, currentCommitSha });
  if (metadata.branch === 'main') {
    throw new Error('Workers Builds preview upload refuses the production branch.');
  }
  return metadata;
}

export function wranglerPreviewUploadArgs(clientId, commitSha, branch) {
  return [
    'exec',
    'wrangler',
    'versions',
    'upload',
    '--var',
    `COMMIT_SHA:${commitSha}`,
    '--var',
    `CLOUDFLARE_OAUTH_CLIENT_ID:${validateOAuthClientId(clientId)}`,
    '--message',
    `Workers Builds preview for ${branch} at ${commitSha}`,
  ];
}

/**
 * Upload an immutable Worker version for a non-production branch without
 * promoting it to the active deployment.
 * @param {{
 *   env?: Record<string, string | undefined>;
 *   clientId?: string;
 *   spawn?: typeof spawnSync;
 * }} [options]
 */
export function uploadWorkersBuildsPreview({
  env = process.env,
  clientId = env.CLOUDFLARE_OAUTH_CLIENT_ID,
  spawn = spawnSync,
} = {}) {
  const currentCommitSha = resolveCurrentCommitSha({ spawn });
  const { branch, commitSha } = validatePreviewBuildContext({
    env,
    spawn,
    currentCommitSha,
  });
  const result = spawn('pnpm', wranglerPreviewUploadArgs(clientId, commitSha, branch), {
    stdio: 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  if (typeof result.status !== 'number') {
    throw new Error('Wrangler preview upload terminated without an exit status.');
  }
  if (result.status !== 0) {
    throw new Error(`Wrangler preview upload failed with exit status ${result.status}.`);
  }
  return commitSha;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const commitSha = uploadWorkersBuildsPreview();
    console.log(`Uploaded undeployed Workers preview version for ${commitSha}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
