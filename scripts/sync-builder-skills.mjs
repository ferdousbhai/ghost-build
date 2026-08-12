import { cp, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifestPath = resolve(root, 'builder-skills.sources.json');
const destination = resolve(root, '.ghostbuild/skills');
const manifest = parseManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
const temporary = await mkdtemp(resolve(tmpdir(), 'ghostbuild-upstream-skills-'));

try {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  const names = new Set();
  for (const [index, source] of manifest.sources.entries()) {
    const repository = resolve(temporary, `source-${index}`);
    runGit(['clone', '--quiet', '--no-checkout', source.repository, repository]);
    runGit(['-C', repository, 'checkout', '--quiet', source.revision, '--', ...source.skills]);
    for (const relativePath of source.skills) {
      const name = basename(relativePath);
      if (names.has(name)) {
        throw new Error(`Builder skill sources contain a duplicate directory name: ${name}`);
      }
      names.add(name);
      const sourcePath = resolveInside(repository, relativePath);
      await cp(sourcePath, resolve(destination, name), { recursive: true, dereference: false, errorOnExist: true });
    }
  }
  console.log(`Synced ${names.size} pinned upstream builder skills.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

function parseManifest(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.sources) || value.sources.length === 0) {
    throw new Error('Builder skill source manifest is invalid.');
  }
  return {
    sources: value.sources.map((source) => {
      if (
        !source ||
        typeof source.repository !== 'string' ||
        !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(source.repository) ||
        typeof source.revision !== 'string' ||
        !/^[a-f0-9]{40}$/.test(source.revision) ||
        !Array.isArray(source.skills) ||
        source.skills.length === 0 ||
        !source.skills.every(validRelativePath)
      ) {
        throw new Error('Builder skill source entry is invalid.');
      }
      return { repository: source.repository, revision: source.revision, skills: source.skills };
    }),
  };
}

function validRelativePath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.startsWith('/') &&
    value.split('/').every((part) => part && part !== '.' && part !== '..')
  );
}

function resolveInside(rootPath, relativePath) {
  const resolved = resolve(rootPath, relativePath);
  if (!resolved.startsWith(`${rootPath}${sep}`)) {
    throw new Error(`Builder skill source path escaped its checkout: ${relativePath}`);
  }
  return resolved;
}

function runGit(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: process.env });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `git exited with status ${result.status}.`);
  }
}
