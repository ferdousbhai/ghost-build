import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = resolve(rootDir, 'template');
const ignoredNames = new Set(['dist', 'node_modules', '.wrangler']);

function run(cwd, args, env = process.env) {
  const result = spawnSync('pnpm', args, {
    cwd,
    encoding: 'utf8',
    stdio: 'inherit',
    env,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`pnpm ${args.join(' ')} failed with exit code ${result.status}.`);
  }
}

export async function verifyTemplate() {
  const tempDir = await mkdtemp(join(tmpdir(), 'ghostbuild-template-'));
  try {
    await cp(sourceDir, tempDir, {
      recursive: true,
      filter: (path) => path === sourceDir || !ignoredNames.has(basename(path)),
    });
    run(tempDir, ['install', '--frozen-lockfile']);
    run(tempDir, ['run', 'verify:stack']);
    run(tempDir, ['run', 'verify:production-config', '--', '--allow-unprovisioned']);
    run(tempDir, ['run', 'typecheck']);
    run(tempDir, ['run', 'lint']);
    run(tempDir, ['run', 'build']);
    run(tempDir, ['exec', 'wrangler', 'deploy', '--dry-run']);
    run(tempDir, ['run', 'build'], { ...process.env, GHOSTBUILD_PREVIEW: '1' });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

await verifyTemplate();
