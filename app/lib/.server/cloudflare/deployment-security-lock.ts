import { sha256Hex } from '~/lib/hex-digest';
const APP_AGENT_PROTECTED_PACKAGES = [
  '@babel/core',
  '@cloudflare/ai-chat',
  '@cloudflare/vite-plugin',
  '@cloudflare/workers-types',
  '@eslint/js',
  '@tanstack/react-router',
  '@tanstack/react-start',
  '@tanstack/router-cli',
  '@types/node',
  '@types/react',
  '@types/react-dom',
  '@vitejs/plugin-react',
  'agents',
  'ai',
  'autoprefixer',
  'eslint',
  'eslint-plugin-react-hooks',
  'eslint-plugin-react-refresh',
  'globals',
  'jsonc-parser',
  'postcss',
  'tailwindcss',
  'typescript',
  'typescript-eslint',
  'vite',
  'workers-ai-provider',
  'wrangler',
  'yaml',
  'zod',
] as const;

type JsonRecord = Record<string, unknown>;

export async function createAppAgentProtectedLockIdentity(lock: JsonRecord): Promise<string> {
  const allowedTopLevelKeys = new Set([
    'lockfileVersion',
    'settings',
    'overrides',
    'importers',
    'packages',
    'snapshots',
  ]);
  if (Object.keys(lock).some((key) => !allowedTopLevelKeys.has(key)) || lock.lockfileVersion !== '9.0') {
    throw new TypeError('protected lockfile has unsupported resolution controls');
  }
  const settings = record(lock.settings);
  if (Object.keys(settings).length === 0) {
    throw new TypeError('protected lockfile settings are missing');
  }
  const overrides = record(lock.overrides);
  if (Object.keys(overrides).length === 0) {
    throw new TypeError('protected lockfile overrides are missing');
  }
  const importer = nestedRecord(lock, 'importers', '.');
  const packages = nestedRecord(lock, 'packages');
  const snapshots = nestedRecord(lock, 'snapshots');
  const dependencies = record(importer.dependencies);
  const devDependencies = record(importer.devDependencies);
  const pending: string[] = [];
  const roots = [...APP_AGENT_PROTECTED_PACKAGES]
    .sort((left, right) => left.localeCompare(right))
    .map((name) => {
      const dependency = dependencies[name];
      const devDependency = devDependencies[name];
      if ((dependency === undefined) === (devDependency === undefined)) {
        throw new TypeError(`protected package ${name} must occur in exactly one importer dependency section`);
      }
      const entry = record(dependency ?? devDependency);
      if (typeof entry.specifier !== 'string' || typeof entry.version !== 'string' || entry.version.length === 0) {
        throw new TypeError(`protected package ${name} must have a specifier and resolved version`);
      }
      pending.push(snapshotKey(name, entry.version));
      return {
        name,
        section: dependency === undefined ? 'devDependencies' : 'dependencies',
        specifier: entry.specifier,
        version: entry.version,
      };
    });

  const visited = new Set<string>();
  const closure: Array<{ id: string; package: unknown; snapshot: unknown }> = [];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (visited.has(id)) {
      continue;
    }
    const snapshot = snapshots[id];
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw new TypeError(`protected package snapshot ${id} is missing`);
    }
    const packageId = packageKey(id);
    const packageEntry = packages[packageId];
    if (!packageEntry || typeof packageEntry !== 'object' || Array.isArray(packageEntry)) {
      throw new TypeError(`protected package resolution ${packageId} is missing`);
    }
    const integrity = nestedRecord(packageEntry, 'resolution').integrity;
    if (typeof integrity !== 'string' || integrity.length === 0) {
      throw new TypeError(`protected package resolution ${packageId} has no integrity`);
    }
    visited.add(id);
    closure.push({ id, package: canonicalize(packageEntry), snapshot: canonicalize(snapshot) });

    const snapshotRecord = record(snapshot);
    for (const section of ['dependencies', 'optionalDependencies'] as const) {
      for (const [dependencyName, reference] of Object.entries(record(snapshotRecord[section]))) {
        if (typeof reference !== 'string' || reference.length === 0) {
          throw new TypeError(`protected package snapshot ${id} has an invalid ${section} edge`);
        }
        pending.push(resolveSnapshotEdge(dependencyName, reference));
      }
    }
  }
  closure.sort((left, right) => left.id.localeCompare(right.id));

  return sha256Hex(
    new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 3,
        lockfileVersion: lock.lockfileVersion,
        settings: canonicalize(settings),
        overrides: canonicalize(overrides),
        roots,
        closure,
      }),
    ),
  );
}

function resolveSnapshotEdge(name: string, reference: string): string {
  if (/^(?:link|file|workspace|https?):/.test(reference)) {
    throw new TypeError(`protected package ${name} uses an unsupported lockfile reference`);
  }
  const target = reference.startsWith('npm:') ? reference.slice(4) : reference;
  if (!reference.startsWith('npm:') && /^[0-9]/.test(target)) {
    return snapshotKey(name, reference);
  }
  const separator = target.startsWith('@') ? target.indexOf('@', target.indexOf('/') + 1) : target.lastIndexOf('@');
  if (separator <= 0 || separator === target.length - 1) {
    return snapshotKey(name, reference);
  }
  return snapshotKey(target.slice(0, separator), target.slice(separator + 1));
}

function snapshotKey(name: string, version: string): string {
  return `${name}@${version}`;
}

function packageKey(snapshot: string): string {
  const peerSuffix = snapshot.indexOf('(');
  return peerSuffix === -1 ? snapshot : snapshot.slice(0, peerSuffix);
}

function nestedRecord(value: unknown, ...keys: string[]): JsonRecord {
  let result = record(value);
  for (const key of keys) {
    result = record(result[key]);
  }
  return result;
}

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}
