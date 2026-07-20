import JSZip, { type JSZipObject } from 'jszip';
import { parse } from 'jsonc-parser';
import { parseDocument } from 'yaml';
import { isLocalSecretFilePath } from '~/utils/secretFiles';
import {
  APP_AGENT_DECLARATIVE_EXPORT,
  DEPLOYMENT_COMPATIBILITY_DATE,
  DEPLOYMENT_COMPATIBILITY_FLAGS,
  DEPLOYMENT_OBSERVABILITY,
} from './deployment-runtime-policy';
import {
  APP_AGENT_PROTECTED_FILE_SHA256,
  APP_AGENT_PROTECTED_LOCK_ENTRIES_SHA256,
  DEPLOYMENT_SECURITY_CLEANUP_CRON,
} from './deployment-security-baseline';

const MAX_DEPLOYMENT_ARCHIVE_ENTRIES = 5_000;
export const MAX_DEPLOYMENT_EXPANDED_BYTES = 250 * 1024 * 1024;
const MAX_METADATA_FILE_BYTES = 1024 * 1024;

export type DeploymentProjectType = 'web_app' | 'worker';

export type DeploymentProjectProfile = {
  type: DeploymentProjectType;
  bindings: {
    ai: boolean;
    d1: boolean;
    r2: boolean;
    appAgent: boolean;
  };
};

type LoadedZipObject = JSZipObject & {
  _data?: { compressedSize?: number; uncompressedSize?: number };
  internalStream(type: 'uint8array'): ZipEntryStream;
};

type ZipEntryStream = {
  on(event: 'data', callback: (chunk: Uint8Array) => void): ZipEntryStream;
  on(event: 'error', callback: (error: Error) => void): ZipEntryStream;
  on(event: 'end', callback: () => void): ZipEntryStream;
  pause(): ZipEntryStream;
  resume(): ZipEntryStream;
};

export async function inspectDeploymentSnapshot(snapshot: Blob | ArrayBuffer): Promise<DeploymentProjectProfile> {
  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(snapshot instanceof Blob ? await snapshot.arrayBuffer() : snapshot, {
      createFolders: false,
    });
  } catch {
    throw new DeploymentSnapshotError('Deployment snapshot must be a valid ZIP archive.');
  }

  const entries = Object.values(archive.files) as LoadedZipObject[];
  if (entries.length === 0 || entries.length > MAX_DEPLOYMENT_ARCHIVE_ENTRIES) {
    throw new DeploymentSnapshotError(
      `Deployment snapshot must contain between 1 and ${MAX_DEPLOYMENT_ARCHIVE_ENTRIES} entries.`,
    );
  }

  let expandedBytes = 0;
  for (const entry of entries) {
    const originalName = entry.unsafeOriginalName ?? entry.name;
    if (!isSafeArchivePath(originalName) || entry.name !== originalName) {
      throw new DeploymentSnapshotError('Deployment snapshot contains an unsafe file path.');
    }
    if (isLocalSecretFilePath(originalName)) {
      throw new DeploymentSnapshotError('Deployment snapshot must not contain a local secret file.');
    }
    if (typeof entry.unixPermissions === 'number' && (entry.unixPermissions & 0o170000) === 0o120000) {
      throw new DeploymentSnapshotError('Deployment snapshot must not contain symbolic links.');
    }
    const uncompressedSize = entry._data?.uncompressedSize;
    if (
      !entry.dir &&
      (typeof uncompressedSize !== 'number' || !Number.isSafeInteger(uncompressedSize) || uncompressedSize < 0)
    ) {
      throw new DeploymentSnapshotError('Deployment snapshot contains invalid size metadata.');
    }
    expandedBytes += entry.dir ? 0 : (uncompressedSize as number);
    if (expandedBytes > MAX_DEPLOYMENT_EXPANDED_BYTES) {
      throw new DeploymentSnapshotError('Deployment snapshot expands beyond the 250 MiB limit.');
    }
  }

  const root = archive.file('package.json') ? '' : archive.file('project/package.json') ? 'project/' : null;
  if (root === null) {
    throw new DeploymentSnapshotError('Deployment snapshot does not contain package.json at a supported root.');
  }
  if (root === '' && archive.file('project/package.json')) {
    throw new DeploymentSnapshotError('Deployment snapshot contains ambiguous project roots.');
  }

  const packageJson = await readMetadataFile(archive, `${root}package.json`);
  const wranglerJson = await readMetadataFile(archive, `${root}wrangler.jsonc`);
  let pkg: {
    ghostbuild?: { projectType?: unknown };
    scripts?: unknown;
    type?: unknown;
    packageManager?: unknown;
    imports?: unknown;
    main?: unknown;
    module?: unknown;
    browser?: unknown;
    exports?: unknown;
    workspaces?: unknown;
    bundleDependencies?: unknown;
    bundledDependencies?: unknown;
    pnpm?: unknown;
    overrides?: unknown;
    resolutions?: unknown;
    dependencies?: unknown;
    devDependencies?: unknown;
  };
  try {
    pkg = JSON.parse(packageJson) as typeof pkg;
  } catch {
    throw new DeploymentSnapshotError('Deployment package.json is invalid.');
  }
  const configuredType = pkg.ghostbuild?.projectType;
  if (configuredType !== undefined && configuredType !== 'web_app' && configuredType !== 'worker') {
    throw new DeploymentSnapshotError('package.json ghostbuild.projectType must be "web_app" or "worker".');
  }
  const type: DeploymentProjectType = configuredType === 'worker' ? 'worker' : 'web_app';
  const config = parse(wranglerJson) as Record<string, unknown> | undefined;
  if (!config || config.main !== 'src/server.ts') {
    throw new DeploymentSnapshotError('wrangler.jsonc must use src/server.ts as the Worker entrypoint.');
  }
  validateSupportedWranglerConfig(config);

  const bindings = {
    ai: hasNamedBinding(config.ai, 'binding', 'AI'),
    d1: hasArrayBinding(config.d1_databases, 'binding', 'DB'),
    r2: hasArrayBinding(config.r2_buckets, 'binding', 'APP_STORAGE'),
    appAgent: hasArrayBinding(config.durable_objects, 'bindings', 'AppAgent', 'name'),
  };
  validateSupportedBindings(config, bindings);
  if (bindings.ai && !bindings.appAgent) {
    throw new DeploymentSnapshotError('Automatic deployment does not allow an unmediated Workers AI binding.');
  }
  if (type === 'web_app' && Object.values(bindings).some((enabled) => !enabled)) {
    throw new DeploymentSnapshotError('Web application snapshots must preserve the template Cloudflare bindings.');
  }
  if (bindings.appAgent) {
    await validateAppAgentSecurityBaseline(archive, root, config);
    await validateNoAlternateAiSinks(archive, root);
  }
  return { type, bindings };
}

async function validateNoAlternateAiSinks(archive: JSZip, root: string): Promise<void> {
  const protectedPaths = new Set(Object.keys(APP_AGENT_PROTECTED_FILE_SHA256));
  const alternateAiPatterns = [
    /cloudflare:workers/,
    /\bimport(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))*\(/,
    /\brequire(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))*\(/,
    /\beval\s*\(/,
    /\[\s*['"]eval['"]\s*\]\s*\(/,
    /\b(?:new\s+)?Function\s*\(/,
    /\[\s*['"]Function['"]\s*\]\s*\(/,
    /\benv\s*(?:\.\s*AI|\[\s*['"]AI['"]\s*\])/,
    /\bcreateWorkersAI\b/,
    /['"]workers-ai-provider['"]/,
    /\bAI\s*:\s*(?:env|context|platform)\b/,
    /\bAGENT_SECURITY_DB\b/,
  ];
  for (const [archivePath, value] of Object.entries(archive.files)) {
    if (!archivePath.startsWith(root)) {
      continue;
    }
    const path = archivePath.slice(root.length);
    if (protectedPaths.has(path) || !/\.(?:[cm]?[jt]sx?)$/.test(path) || value.dir) {
      continue;
    }
    const entry = value as LoadedZipObject;
    const size = entry._data?.uncompressedSize;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || size > MAX_METADATA_FILE_BYTES) {
      throw new DeploymentSnapshotError(`Deployment source file ${path} is too large for security inspection.`);
    }
    const content = normalizeJavaScriptForSecurityScan(await readBoundedEntry(entry, `${root}${path}`));
    if (alternateAiPatterns.some((pattern) => pattern.test(content))) {
      throw new DeploymentSnapshotError(
        `Deployment source file ${path} contains an unreviewed protected runtime binding access path.`,
      );
    }
  }
}

function normalizeJavaScriptForSecurityScan(source: string): string {
  return source
    .replace(/\\\r?\n/g, '')
    .replace(/\\x([0-9a-fA-F]{2})/g, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (match, hex: string) => {
      const codePoint = Number.parseInt(hex, 16);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
    })
    .replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)));
}

export class DeploymentSnapshotError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DeploymentSnapshotError';
  }
}

function isSafeArchivePath(path: string): boolean {
  if (!path || path.includes('\\') || path.includes('\0') || path.startsWith('/')) {
    return false;
  }
  return path.split('/').every((segment) => segment !== '..' && segment !== '.');
}

async function readMetadataFile(archive: JSZip, path: string): Promise<string> {
  const entry = archive.file(path) as LoadedZipObject | null;
  const size = entry?._data?.uncompressedSize;
  if (!entry || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || size > MAX_METADATA_FILE_BYTES) {
    throw new DeploymentSnapshotError(`Deployment snapshot must contain a valid ${path}.`);
  }
  return readBoundedEntry(entry, path);
}

function readBoundedEntry(entry: LoadedZipObject, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stream = entry.internalStream('uint8array');
    const decoder = new TextDecoder();
    let content = '';
    let bytes = 0;
    let settled = false;
    stream.on('data', (chunk: Uint8Array) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_METADATA_FILE_BYTES) {
        settled = true;
        stream.pause();
        reject(new DeploymentSnapshotError(`Deployment snapshot ${path} exceeds the metadata size limit.`));
        return;
      }
      content += decoder.decode(chunk, { stream: true });
    });
    stream.on('error', (error: Error) => {
      if (!settled) {
        settled = true;
        reject(new DeploymentSnapshotError(`Deployment snapshot must contain a valid ${path}.`, { cause: error }));
      }
    });
    stream.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(content + decoder.decode());
      }
    });
    stream.resume();
  });
}

function hasNamedBinding(value: unknown, key: string, expected: string): boolean {
  return typeof value === 'object' && value !== null && (value as Record<string, unknown>)[key] === expected;
}

function hasArrayBinding(
  value: unknown,
  collectionOrKey: string,
  expected: string,
  nestedKey = collectionOrKey,
): boolean {
  const collection = Array.isArray(value)
    ? value
    : typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)[collectionOrKey]
      : null;
  return (
    Array.isArray(collection) &&
    collection.some(
      (entry) =>
        typeof entry === 'object' && entry !== null && (entry as Record<string, unknown>)[nestedKey] === expected,
    )
  );
}

const SUPPORTED_WRANGLER_KEYS = new Set([
  '$schema',
  'name',
  'compatibility_date',
  'compatibility_flags',
  'main',
  'observability',
  'upload_source_maps',
  'triggers',
  'ai',
  'd1_databases',
  'r2_buckets',
  'durable_objects',
  'exports',
]);

function validateSupportedWranglerConfig(config: Record<string, unknown>): void {
  const unsupported = Object.keys(config).filter((key) => !SUPPORTED_WRANGLER_KEYS.has(key));
  if (unsupported.length > 0) {
    throw new DeploymentSnapshotError(
      `Automatic deployment does not yet support wrangler.jsonc ${unsupported.sort().join(', ')} configuration.`,
    );
  }
  if (config.compatibility_date !== DEPLOYMENT_COMPATIBILITY_DATE) {
    throw unsupportedWranglerSetting('compatibility_date');
  }
  if (JSON.stringify(config.compatibility_flags) !== JSON.stringify(DEPLOYMENT_COMPATIBILITY_FLAGS)) {
    throw unsupportedWranglerSetting('compatibility_flags');
  }
  if (JSON.stringify(config.observability) !== JSON.stringify(DEPLOYMENT_OBSERVABILITY)) {
    throw unsupportedWranglerSetting('observability');
  }
  if (config.upload_source_maps !== true) {
    throw unsupportedWranglerSetting('upload_source_maps');
  }
}

async function validateAppAgentSecurityBaseline(
  archive: JSZip,
  root: string,
  config: Record<string, unknown>,
): Promise<void> {
  const packageJson = await readMetadataFile(archive, `${root}package.json`);
  validateAppAgentPackage(JSON.parse(packageJson) as Record<string, unknown>);
  await validateAppAgentLockfile(archive, root);
  if (JSON.stringify(config.triggers) !== JSON.stringify({ crons: [DEPLOYMENT_SECURITY_CLEANUP_CRON] })) {
    throw new DeploymentSnapshotError('AppAgent snapshots must preserve the reviewed security cleanup trigger.');
  }
  for (const [path, expectedSha256] of Object.entries(APP_AGENT_PROTECTED_FILE_SHA256)) {
    const entry = archive.file(`${root}${path}`) as LoadedZipObject | null;
    const size = entry?._data?.uncompressedSize;
    if (
      !entry ||
      typeof size !== 'number' ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > MAX_METADATA_FILE_BYTES
    ) {
      throw new DeploymentSnapshotError(`AppAgent snapshot security file ${path} is missing or invalid.`);
    }
    const content = await readBoundedEntry(entry, `${root}${path}`);
    if ((await sha256Hex(new TextEncoder().encode(content))) !== expectedSha256) {
      throw new DeploymentSnapshotError(
        `AppAgent snapshot security file ${path} differs from the reviewed deployment baseline.`,
      );
    }
  }
  const protectedMigrationPrefix = `${root}agent-security-migrations/`;
  const expectedProtectedMigrations = new Set(
    Object.keys(APP_AGENT_PROTECTED_FILE_SHA256)
      .filter((path) => path.startsWith('agent-security-migrations/'))
      .map((path) => `${root}${path}`),
  );
  const actualProtectedMigrations = Object.values(archive.files)
    .filter((entry) => !entry.dir && entry.name.startsWith(protectedMigrationPrefix))
    .map((entry) => entry.name);
  if (
    actualProtectedMigrations.length !== expectedProtectedMigrations.size ||
    actualProtectedMigrations.some((path) => !expectedProtectedMigrations.has(path))
  ) {
    throw new DeploymentSnapshotError('AppAgent snapshots must preserve only the reviewed agent security migrations.');
  }
}

function validateAppAgentPackage(pkg: Record<string, unknown>): void {
  if (
    pkg.type !== 'module' ||
    pkg.packageManager !== 'pnpm@11.14.0' ||
    JSON.stringify(pkg.imports) !== JSON.stringify({ '#/*': './src/*' })
  ) {
    throw new DeploymentSnapshotError(
      'AppAgent package.json must preserve the reviewed module type, package manager, and import mapping.',
    );
  }
  if (
    ['main', 'module', 'browser', 'exports', 'workspaces', 'bundleDependencies', 'bundledDependencies'].some(
      (field) => pkg[field] !== undefined,
    )
  ) {
    throw new DeploymentSnapshotError('AppAgent package.json must not add module or workspace resolver overrides.');
  }
  const scripts = pkg.scripts;
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) {
    throw new DeploymentSnapshotError('AppAgent package.json must preserve the reviewed build scripts.');
  }
  const expectedScripts: Record<string, string> = {
    'generate-routes': 'tsr generate',
    'cf-typegen': 'node scripts/cf-typegen.mjs',
    typecheck: 'pnpm run generate-routes && pnpm run cf-typegen && tsc -p . --noEmit --pretty false',
    'verify:stack': 'node scripts/verify-stack-alignment.mjs',
    'verify:licenses': 'node scripts/verify-production-licenses.mjs',
    'verify:licenses:built': 'node scripts/verify-production-licenses.mjs --built',
    'licenses:generate': 'node scripts/verify-production-licenses.mjs --write-notices',
    build: 'pnpm run verify:licenses && vite build && pnpm run verify:licenses:built',
    lint: 'eslint src vite.config.ts scripts/verify-production-licenses.mjs scripts/lib/runtime-module-security.ts scripts/lib/production-license-artifact.mjs --max-warnings=0',
  };
  const scriptRecord = scripts as Record<string, unknown>;
  for (const [name, expected] of Object.entries(expectedScripts)) {
    if (scriptRecord[name] !== expected) {
      throw new DeploymentSnapshotError(`AppAgent package.json script ${name} differs from the reviewed build path.`);
    }
    if (scriptRecord[`pre${name}`] !== undefined || scriptRecord[`post${name}`] !== undefined) {
      throw new DeploymentSnapshotError(`AppAgent package.json must not wrap the ${name} build script.`);
    }
  }
  for (const lifecycle of ['preinstall', 'install', 'postinstall', 'prepare']) {
    if (scriptRecord[lifecycle] !== undefined) {
      throw new DeploymentSnapshotError(`AppAgent package.json must not define the ${lifecycle} lifecycle script.`);
    }
  }
  if (pkg.pnpm !== undefined || pkg.overrides !== undefined || pkg.resolutions !== undefined) {
    throw new DeploymentSnapshotError('AppAgent package.json must not override the reviewed dependency resolver.');
  }
  const expectedBuildPackages: Record<string, string> = {
    '@cloudflare/ai-chat': '^0.9.3',
    '@tanstack/react-router': '^1.170.18',
    '@tanstack/react-start': '^1.168.30',
    agents: '^0.17.4',
    ai: '^6.0.230',
    'workers-ai-provider': '^3.3.1',
    '@cloudflare/vite-plugin': '1.45.1',
    '@eslint/js': '^10.0.1',
    '@tanstack/router-cli': '^1.167.21',
    '@vitejs/plugin-react': '^6.0.3',
    autoprefixer: '~10.5.4',
    eslint: '^10.7.0',
    'eslint-plugin-react-hooks': '^7.1.1',
    'eslint-plugin-react-refresh': '^0.5.3',
    postcss: '~8.5.19',
    tailwindcss: '~3.4.19',
    typescript: '~6.0.3',
    'typescript-eslint': '^8.64.0',
    vite: '^8.1.5',
    wrangler: '4.112.0',
  };
  const dependencies = dependencyRecord(pkg.dependencies);
  const devDependencies = dependencyRecord(pkg.devDependencies);
  for (const [name, expected] of Object.entries(expectedBuildPackages)) {
    const declared = dependencies[name] ?? devDependencies[name];
    if (declared !== expected || (dependencies[name] !== undefined && devDependencies[name] !== undefined)) {
      throw new DeploymentSnapshotError(
        `AppAgent package.json build dependency ${name} differs from the reviewed spec.`,
      );
    }
  }
}

function dependencyRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const APP_AGENT_PROTECTED_PACKAGES = [
  '@cloudflare/ai-chat',
  '@tanstack/react-router',
  '@tanstack/react-start',
  'agents',
  'ai',
  'workers-ai-provider',
  '@cloudflare/vite-plugin',
  '@eslint/js',
  '@tanstack/router-cli',
  '@vitejs/plugin-react',
  'autoprefixer',
  'eslint',
  'eslint-plugin-react-hooks',
  'eslint-plugin-react-refresh',
  'postcss',
  'tailwindcss',
  'typescript',
  'typescript-eslint',
  'vite',
  'wrangler',
] as const;

async function validateAppAgentLockfile(archive: JSZip, root: string): Promise<void> {
  const source = await readMetadataFile(archive, `${root}pnpm-lock.yaml`);
  let lock: Record<string, unknown>;
  try {
    const document = parseDocument(source);
    if (document.errors.length > 0) {
      throw document.errors[0];
    }
    const parsed = document.toJS({ maxAliasCount: 20 });
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError('pnpm lockfile root must be an object');
    }
    lock = parsed as Record<string, unknown>;
  } catch (error) {
    throw new DeploymentSnapshotError('AppAgent pnpm-lock.yaml is invalid.', { cause: error });
  }

  const importer = nestedRecord(lock, 'importers', '.');
  const packages = nestedRecord(lock, 'packages');
  const dependencies = dependencyRecord(importer.dependencies);
  const devDependencies = dependencyRecord(importer.devDependencies);
  const protectedEntries = APP_AGENT_PROTECTED_PACKAGES.toSorted().map((name) => {
    const entry = dependencyRecord(dependencies[name] ?? devDependencies[name]);
    const specifier = entry.specifier;
    const versionWithPeers = entry.version;
    const version = typeof versionWithPeers === 'string' ? versionWithPeers.split('(', 1)[0] : undefined;
    const resolution = typeof version === 'string' ? nestedRecord(packages, `${name}@${version}`, 'resolution') : {};
    const integrity = resolution.integrity;
    if (
      typeof specifier !== 'string' ||
      typeof version !== 'string' ||
      version.length === 0 ||
      typeof integrity !== 'string' ||
      integrity.length === 0 ||
      (dependencies[name] !== undefined && devDependencies[name] !== undefined)
    ) {
      throw new DeploymentSnapshotError(`AppAgent pnpm-lock.yaml does not pin the reviewed ${name} package identity.`);
    }
    return { name, specifier, version, integrity };
  });
  const digest = await sha256Hex(new TextEncoder().encode(JSON.stringify(protectedEntries)));
  if (digest !== APP_AGENT_PROTECTED_LOCK_ENTRIES_SHA256) {
    throw new DeploymentSnapshotError('AppAgent pnpm-lock.yaml changes the reviewed security or build toolchain.');
  }
}

function nestedRecord(value: unknown, ...keys: string[]): Record<string, unknown> {
  let record = dependencyRecord(value);
  for (const key of keys) {
    record = dependencyRecord(record[key]);
  }
  return record;
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', value as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function unsupportedWranglerSetting(setting: string): DeploymentSnapshotError {
  return new DeploymentSnapshotError(
    `Automatic deployment requires the template wrangler.jsonc ${setting} setting; custom values are not yet supported.`,
  );
}

function validateSupportedBindings(
  config: Record<string, unknown>,
  bindings: DeploymentProjectProfile['bindings'],
): void {
  if (config.ai !== undefined && JSON.stringify(config.ai) !== JSON.stringify({ binding: 'AI' })) {
    throw unsupportedBinding('AI', 'AI');
  }
  validateD1Bindings(config.d1_databases, bindings.appAgent);
  validateExclusiveArrayBinding(config.r2_buckets, 'binding', 'APP_STORAGE', 'R2', {
    allowedKeys: ['binding', 'bucket_name'],
  });
  const durableBindings =
    typeof config.durable_objects === 'object' && config.durable_objects !== null
      ? (config.durable_objects as Record<string, unknown>).bindings
      : undefined;
  validateExclusiveArrayBinding(durableBindings, 'name', 'AppAgent', 'Durable Object', {
    class_name: 'AppAgent',
    allowedKeys: ['name', 'class_name'],
  });
  const requiredExports = { AppAgent: APP_AGENT_DECLARATIVE_EXPORT };
  if (bindings.appAgent && JSON.stringify(config.exports) !== JSON.stringify(requiredExports)) {
    throw unsupportedBinding('Durable Object export', 'AppAgent');
  }
  if (!bindings.appAgent && config.exports !== undefined) {
    throw unsupportedBinding('Durable Object export', 'AppAgent');
  }
}

function validateD1Bindings(value: unknown, requiresAgentSecurityDb: boolean): void {
  if (value === undefined) {
    if (requiresAgentSecurityDb) {
      throw unsupportedBinding('D1', 'DB and AGENT_SECURITY_DB');
    }
    return;
  }
  if (!Array.isArray(value)) {
    throw unsupportedBinding('D1', requiresAgentSecurityDb ? 'DB and AGENT_SECURITY_DB' : 'DB');
  }
  const expected = requiresAgentSecurityDb
    ? new Map([
        ['DB', 'migrations'],
        ['AGENT_SECURITY_DB', 'agent-security-migrations'],
      ])
    : new Map([['DB', 'migrations']]);
  if (value.length !== expected.size) {
    throw unsupportedBinding('D1', [...expected.keys()].join(' and '));
  }
  const allowedKeys = ['binding', 'database_name', 'database_id', 'migrations_dir'];
  for (const entry of value) {
    const binding =
      typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>).binding : undefined;
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof binding !== 'string' ||
      !expected.has(binding) ||
      (entry as Record<string, unknown>).migrations_dir !== expected.get(binding) ||
      Object.keys(entry as Record<string, unknown>).some((key) => !allowedKeys.includes(key))
    ) {
      throw unsupportedBinding('D1', [...expected.keys()].join(' and '));
    }
  }
  if (new Set(value.map((entry) => (entry as Record<string, unknown>).binding)).size !== expected.size) {
    throw unsupportedBinding('D1', [...expected.keys()].join(' and '));
  }
}

function validateExclusiveArrayBinding(
  value: unknown,
  key: string,
  expected: string,
  product: string,
  options: { class_name?: string; migrations_dir?: string; allowedKeys: string[] },
): void {
  if (value === undefined) {
    return;
  }
  if (
    !Array.isArray(value) ||
    value.length !== 1 ||
    typeof value[0] !== 'object' ||
    value[0] === null ||
    (value[0] as Record<string, unknown>)[key] !== expected ||
    (options.class_name !== undefined && (value[0] as Record<string, unknown>).class_name !== options.class_name) ||
    (options.migrations_dir !== undefined &&
      (value[0] as Record<string, unknown>).migrations_dir !== options.migrations_dir) ||
    Object.keys(value[0] as Record<string, unknown>).some((entryKey) => !options.allowedKeys.includes(entryKey))
  ) {
    throw unsupportedBinding(product, expected);
  }
}

function unsupportedBinding(product: string, supportedBinding: string): DeploymentSnapshotError {
  return new DeploymentSnapshotError(
    `Automatic deployment currently supports only the ${supportedBinding} ${product} binding.`,
  );
}
