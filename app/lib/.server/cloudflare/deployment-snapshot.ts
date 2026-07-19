import JSZip, { type JSZipObject } from 'jszip';
import { parse } from 'jsonc-parser';
import { isLocalSecretFilePath } from '~/utils/secretFiles';
import {
  APP_AGENT_DECLARATIVE_EXPORT,
  DEPLOYMENT_COMPATIBILITY_DATE,
  DEPLOYMENT_COMPATIBILITY_FLAGS,
  DEPLOYMENT_OBSERVABILITY,
} from './deployment-runtime-policy';

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
  let pkg: { ghostbuild?: { projectType?: unknown } };
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
  if (type === 'web_app' && Object.values(bindings).some((enabled) => !enabled)) {
    throw new DeploymentSnapshotError('Web application snapshots must preserve the template Cloudflare bindings.');
  }
  return { type, bindings };
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
  validateExclusiveArrayBinding(config.d1_databases, 'binding', 'DB', 'D1', {
    migrations_dir: 'migrations',
    allowedKeys: ['binding', 'database_name', 'database_id', 'migrations_dir'],
  });
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
