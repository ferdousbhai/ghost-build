import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { BUILDER_SKILLS_BUCKET, BUILDER_SKILLS_POINTER_KEY, packBuilderSkills } from './lib/builder-skills.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const options = parseArguments(process.argv.slice(2));
if (!options.skipSync) {
  runCommand(process.execPath, [resolve(root, 'scripts/sync-builder-skills.mjs')]);
}
const packed = await packBuilderSkills(resolve(root, options.directory));

if (options.dryRun) {
  console.log(`Validated ${packed.pointer.skills.length} upstream builder skills (${packed.entries.length} files).`);
  process.exit(0);
}

const tempDirectory = await mkdtemp(resolve(tmpdir(), 'ghostbuild-builder-skills-'));
try {
  const manifestKey = `generations/${packed.generation}/manifest.json`;
  const existingManifest = runWrangler(
    ['r2', 'object', 'get', `${BUILDER_SKILLS_BUCKET}/${manifestKey}`, '--pipe', options.target],
    { allowFailure: true },
  );
  if (existingManifest.status === 0) {
    if (existingManifest.stdout.trim() !== packed.manifestSerialized) {
      throw new Error(`Published builder skill generation ${packed.generation} is not immutable.`);
    }
  } else if (!/specified key does not exist/i.test(`${existingManifest.stdout}\n${existingManifest.stderr}`)) {
    throw new Error(
      existingManifest.stderr.trim() ||
        existingManifest.stdout.trim() ||
        'Unable to verify the published builder skill generation.',
    );
  } else {
    for (const [index, entry] of packed.entries.entries()) {
      const file = resolve(tempDirectory, `object-${index}`);
      await writeFile(file, entry.content, { mode: 0o600 });
      runWrangler([
        'r2',
        'object',
        'put',
        `${BUILDER_SKILLS_BUCKET}/generations/${packed.generation}/skills/${entry.name}/${entry.path}`,
        '--file',
        file,
        '--content-type',
        entry.contentType,
        options.target,
      ]);
    }
    const manifestPath = resolve(tempDirectory, 'manifest.json');
    await writeFile(manifestPath, packed.manifestSerialized, { encoding: 'utf8', mode: 0o600 });
    runWrangler([
      'r2',
      'object',
      'put',
      `${BUILDER_SKILLS_BUCKET}/${manifestKey}`,
      '--file',
      manifestPath,
      '--content-type',
      'application/json',
      options.target,
    ]);
  }
  const pointerPath = resolve(tempDirectory, 'current.json');
  await writeFile(pointerPath, packed.pointerSerialized, { encoding: 'utf8', mode: 0o600 });
  runWrangler([
    'r2',
    'object',
    'put',
    `${BUILDER_SKILLS_BUCKET}/${BUILDER_SKILLS_POINTER_KEY}`,
    '--file',
    pointerPath,
    '--content-type',
    'application/json',
    options.target,
  ]);
  const readback = runWrangler([
    'r2',
    'object',
    'get',
    `${BUILDER_SKILLS_BUCKET}/${BUILDER_SKILLS_POINTER_KEY}`,
    '--pipe',
    options.target,
  ]);
  if (readback.trim() !== packed.pointerSerialized) {
    throw new Error('Published builder skill pointer did not match its readback.');
  }
  console.log(`Published ${packed.pointer.skills.length} upstream builder skills as ${packed.generation}.`);
} finally {
  await rm(tempDirectory, { recursive: true, force: true });
}

function parseArguments(args) {
  let target;
  let dryRun = false;
  let directory = '.ghostbuild/skills';
  let skipSync = false;
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
      skipSync = true;
    } else {
      throw new Error(`Unknown builder skill seed option: ${argument}`);
    }
  }
  if (!dryRun && !target) {
    throw new Error('Choose --local or --remote when publishing builder skills.');
  }
  return { target, dryRun, directory, skipSync };
}

function runWrangler(args, options = {}) {
  const result = spawnSync('pnpm', ['exec', 'wrangler', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `Wrangler exited with status ${result.status}.`);
  }
  return options.allowFailure ? result : result.stdout;
}

function runCommand(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', env: process.env, stdio: 'inherit' });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Builder skill sync exited with status ${result.status}.`);
  }
}
