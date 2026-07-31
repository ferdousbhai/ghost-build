import { getSandbox, type ExecResult } from '@cloudflare/sandbox';
import type { DeploymentSandbox } from './deployment-sandbox';
import { buildDeploymentSnapshot, runBoundedDeploymentBuildCommand } from './deployment-build-executor';
import { inspectDeploymentSnapshot } from './deployment-snapshot';
import { trackSandboxLifecycle, type TrackedSandboxLifecycle } from './sandbox-cleanup';
import { sandboxExec } from './sandbox-lifecycle';
import { cancelObjectGcCandidate, queueObjectGcCandidate } from '~/lib/cloudflare/data/object-gc.server';

const PROJECT_DIR = '/workspace/project';
const SOURCE_ARCHIVE = '/workspace/source.zip';
const MAX_WORKSPACE_FILE_BYTES = 16 * 1024 * 1024;

export async function installBuilderDependencies(args: {
  env: Env;
  operationId: string;
  snapshot: Uint8Array<ArrayBuffer>;
  packageJson: string;
  abortSignal?: AbortSignal;
}): Promise<{ packageJson: string; pnpmLock: string; durationMs: number }> {
  if (!args.env.DeploymentSandbox) {
    throw new Error('Deployment Sandbox binding is unavailable.');
  }
  const dependencySandboxId = await sandboxId('dependencies', args.operationId);
  const sandbox = getSandbox(
    args.env.DeploymentSandbox as DurableObjectNamespace<DeploymentSandbox>,
    dependencySandboxId,
    { transport: 'rpc', enableDefaultSession: false, normalizeId: true },
  );
  const lifecycle = await trackSandboxLifecycle({
    db: args.env.DB,
    sandbox,
    sandboxId: dependencySandboxId,
    operation: 'dependency sandbox',
  });
  const startedAt = Date.now();
  const cleanup = abortableSandboxCleanup(lifecycle, args.abortSignal);
  try {
    args.abortSignal?.throwIfAborted();
    await requireSuccess(
      await sandboxExec(sandbox, `rm -rf ${PROJECT_DIR} ${SOURCE_ARCHIVE}`, {
        timeout: 30_000,
      }),
    );
    await sandbox.mkdir(PROJECT_DIR, { recursive: true });
    await sandbox.writeFile(SOURCE_ARCHIVE, new Blob([args.snapshot]).stream());
    await requireSuccess(
      await sandboxExec(sandbox, `unzip -q ${SOURCE_ARCHIVE} -d ${PROJECT_DIR}`, {
        timeout: 60_000,
      }),
    );
    await sandbox.writeFile(`${PROJECT_DIR}/package.json`, args.packageJson);
    await requireSuccess(
      await sandboxExec(sandbox, 'ghostbuild-verify-pnpm-workspace pnpm-workspace.yaml', {
        cwd: PROJECT_DIR,
        timeout: 30_000,
      }),
    );
    const pnpm = requireExecutable(await sandboxExec(sandbox, 'command -v pnpm', { timeout: 30_000 }), 'pnpm');
    await requireSuccess(
      await runBoundedDeploymentBuildCommand(
        sandbox,
        `${shellQuote(pnpm)} install --lockfile-only --ignore-scripts=true --ignore-pnpmfile ` +
          '--registry=https://registry.npmjs.org/',
        { cwd: PROJECT_DIR, timeout: 4 * 60_000 },
      ),
    );
    await requireSuccess(
      await sandboxExec(
        sandbox,
        `test "$(stat -c %s package.json)" -le ${MAX_WORKSPACE_FILE_BYTES} && ` +
          `test "$(stat -c %s pnpm-lock.yaml)" -le ${MAX_WORKSPACE_FILE_BYTES}`,
        { cwd: PROJECT_DIR, timeout: 30_000 },
      ),
    );
    const [packageJson, pnpmLock] = await Promise.all([
      sandbox.readFile(`${PROJECT_DIR}/package.json`, { encoding: 'utf8' }),
      sandbox.readFile(`${PROJECT_DIR}/pnpm-lock.yaml`, { encoding: 'utf8' }),
    ]);
    return {
      packageJson: packageJson.content,
      pnpmLock: pnpmLock.content,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    await cleanup();
  }
}

export async function validateBuilderProject(args: {
  env: Env;
  operationId: string;
  snapshot: Uint8Array<ArrayBuffer>;
  abortSignal?: AbortSignal;
}): Promise<{ durationMs: number }> {
  args.abortSignal?.throwIfAborted();
  const project = await inspectDeploymentSnapshot(args.snapshot.buffer);
  const sourceSha256 = await sha256Bytes(args.snapshot);
  const deploymentId = await deterministicUuid(`validation:${args.operationId}`);
  const snapshotKey = `builder-validations/${deploymentId}.zip`;
  const startedAt = Date.now();
  const gcReceipt = await queueObjectGcCandidate(args.env.DB, snapshotKey, Date.now() + 30 * 60_000);
  await args.env.APP_STORAGE.put(snapshotKey, args.snapshot);
  try {
    await buildDeploymentSnapshot({
      env: args.env,
      deploymentId,
      snapshotKey,
      expectedSourceSha256: sourceSha256,
      project,
      validationOnly: true,
      abortSignal: args.abortSignal,
    });
    return { durationMs: Date.now() - startedAt };
  } finally {
    try {
      await args.env.APP_STORAGE.delete(snapshotKey);
      await cancelObjectGcCandidate(args.env.DB, gcReceipt);
    } catch (error) {
      console.error('Unable to remove temporary Builder validation snapshot', error);
    }
  }
}

function abortableSandboxCleanup(
  lifecycle: TrackedSandboxLifecycle,
  abortSignal: AbortSignal | undefined,
): () => Promise<void> {
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => {
    cleanupPromise ??= lifecycle.destroy();
    return cleanupPromise;
  };
  const handleAbort = () => {
    void cleanup();
  };
  abortSignal?.addEventListener('abort', handleAbort, { once: true });
  return async () => {
    abortSignal?.removeEventListener('abort', handleAbort);
    await cleanup();
  };
}

export function deterministicDeploymentId(value: string): Promise<string> {
  return deterministicUuid(`deployment:${value}`);
}

async function sandboxId(prefix: string, value: string): Promise<string> {
  return `${prefix}-${(await sha256Text(value)).slice(0, 32)}`;
}

async function deterministicUuid(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes.subarray(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function requireExecutable(result: ExecResult, name: string): string {
  if (!result.success || !/^\/[A-Za-z0-9._+/-]+$/.test(result.stdout.trim())) {
    throw new Error(`The isolated build image does not provide a valid ${name} executable.`);
  }
  return result.stdout.trim();
}

function requireSuccess(result: ExecResult): void {
  if (!result.success) {
    const detail = `${result.stderr}\n${result.stdout}`.trim().slice(-4_000);
    throw new Error(detail || `Isolated command failed with exit code ${result.exitCode}.`);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function sha256Text(value: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(value));
}

async function sha256Bytes(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', value as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
