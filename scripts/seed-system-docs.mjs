import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  packSystemDocsDirectory,
  SYSTEM_DOCS_MANAGED_KEY,
  SYSTEM_DOCS_PUBLISHED_KEY,
} from './lib/system-docs-bundle.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const options = parseArguments(process.argv.slice(2));
const { bundle, serialized, managedSerialized } = await packSystemDocsDirectory(resolve(root, options.directory));

if (options.dryRun) {
  console.log(`Validated ${bundle.documents.length} system documents.`);
  process.exit(0);
}

const tempDirectory = await mkdtemp(resolve(tmpdir(), 'ghostbuild-system-docs-'));
const bundlePath = resolve(tempDirectory, 'bundle.json');
const managedBundlePath = resolve(tempDirectory, 'managed-bundle.json');
try {
  await writeFile(bundlePath, serialized, { encoding: 'utf8', mode: 0o600 });
  await writeFile(managedBundlePath, managedSerialized, { encoding: 'utf8', mode: 0o600 });
  runWrangler([
    'kv',
    'key',
    'put',
    SYSTEM_DOCS_MANAGED_KEY,
    '--binding',
    'SYSTEM_DOCS',
    '--path',
    managedBundlePath,
    options.target,
  ]);
  const managedReadback = runWrangler([
    'kv',
    'key',
    'get',
    SYSTEM_DOCS_MANAGED_KEY,
    '--binding',
    'SYSTEM_DOCS',
    '--text',
    options.target,
  ]);
  if (managedReadback.trim() !== managedSerialized) {
    throw new Error('Managed system documentation did not match its readback.');
  }
  runWrangler([
    'kv',
    'key',
    'put',
    SYSTEM_DOCS_PUBLISHED_KEY,
    '--binding',
    'SYSTEM_DOCS',
    '--path',
    bundlePath,
    options.target,
  ]);
  const readback = runWrangler([
    'kv',
    'key',
    'get',
    SYSTEM_DOCS_PUBLISHED_KEY,
    '--binding',
    'SYSTEM_DOCS',
    '--text',
    options.target,
  ]);
  if (readback.trim() !== serialized) {
    throw new Error('Published system documentation did not match its readback.');
  }
  console.log(`Published ${bundle.documents.length} system documents.`);
} finally {
  await rm(tempDirectory, { recursive: true, force: true });
}

function parseArguments(args) {
  let target;
  let dryRun = false;
  let directory = '.ghostbuild/docs';
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--') {
      continue;
    } else if (argument === '--local' || argument === '--remote') {
      if (target) {
        throw new Error('Choose exactly one of --local or --remote.');
      }
      target = argument;
    } else if (argument === '--dry-run') {
      dryRun = true;
    } else if (argument === '--directory') {
      directory = args[index + 1];
      index += 1;
      if (!directory) {
        throw new Error('--directory requires a path.');
      }
    } else {
      throw new Error(`Unknown system documentation seed option: ${argument}`);
    }
  }
  if (!dryRun && !target) {
    throw new Error('Choose --local or --remote when publishing system documentation.');
  }
  return { target, dryRun, directory };
}

function runWrangler(args) {
  const result = spawnSync('pnpm', ['exec', 'wrangler', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `Wrangler exited with status ${result.status}.`);
  }
  return result.stdout;
}
