import { getSandbox, type ExecResult } from '@cloudflare/sandbox';
import { BUILDER_PREVIEW_PORT, BUILDER_PREVIEW_TTL_MS } from '~/agents/builder-preview-types';
import type { DeploymentSandbox } from './deployment-sandbox';
import { runBoundedDeploymentBuildCommand } from './deployment-build-executor';
import { trackSandboxLifecycle } from './sandbox-cleanup';
import { sandboxExec } from './sandbox-lifecycle';

const PROJECT_DIR = '/workspace/preview-project';
const SOURCE_ARCHIVE = '/workspace/preview-source.zip';
const TRUSTED_BIN_DIR = '/workspace/preview-trusted-bin';
const BUILD_TIMEOUT_MS = 4 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 4 * 60 * 1000;
const PREVIEW_READY_TIMEOUT_MS = 45_000;
const MAX_EXPANDED_KIB = 250 * 1024;
const MAX_ERROR_BYTES = 4_000;

export async function buildBuilderPreview(args: {
  env: Pick<Env, 'APP_STORAGE' | 'DB' | 'DeploymentSandbox'>;
  sandboxId: string;
  snapshotKey: string;
  previewBasePath: string;
}): Promise<void> {
  const source = await args.env.APP_STORAGE.get(args.snapshotKey);
  if (!source) {
    throw new Error('The immutable preview snapshot is unavailable.');
  }
  const sandbox = getSandbox(args.env.DeploymentSandbox as DurableObjectNamespace<DeploymentSandbox>, args.sandboxId, {
    transport: 'rpc',
    enableDefaultSession: false,
    normalizeId: true,
  });
  const lifecycle = await trackSandboxLifecycle({
    db: args.env.DB,
    sandbox,
    sandboxId: args.sandboxId,
    operation: 'Builder preview sandbox',
  });
  try {
    await sandbox.setKeepAlive(false);
    await requireSuccess(
      await sandboxExec(sandbox, `rm -rf ${PROJECT_DIR} ${SOURCE_ARCHIVE} ${TRUSTED_BIN_DIR}`, {
        timeout: 30_000,
      }),
    );
    await sandbox.writeFile(SOURCE_ARCHIVE, source.body);
    await sandbox.mkdir(PROJECT_DIR, { recursive: true });
    await requireSuccess(
      await sandboxExec(sandbox, `unzip -q ${SOURCE_ARCHIVE} -d ${PROJECT_DIR}`, { timeout: 60_000 }),
    );
    await requireSuccess(
      await sandboxExec(
        sandbox,
        `test -f package.json && test -f pnpm-lock.yaml && test -f pnpm-workspace.yaml && ` +
          `test "$(du -sk . | cut -f1)" -le ${MAX_EXPANDED_KIB} && ` +
          'ghostbuild-verify-pnpm-workspace pnpm-workspace.yaml',
        { cwd: PROJECT_DIR, timeout: 30_000 },
      ),
    );
    const node = requireExecutable(await sandboxExec(sandbox, 'command -v node', { timeout: 30_000 }), 'Node.js');
    const pnpm = requireExecutable(await sandboxExec(sandbox, 'command -v pnpm', { timeout: 30_000 }), 'pnpm');
    await requireSuccess(
      await runBoundedDeploymentBuildCommand(
        sandbox,
        `${shellQuote(pnpm)} install --frozen-lockfile --ignore-scripts=true --ignore-pnpmfile ` +
          '--registry=https://registry.npmjs.org/',
        { cwd: PROJECT_DIR, timeout: INSTALL_TIMEOUT_MS },
      ),
    );
    await requireSuccess(
      await sandboxExec(
        sandbox,
        `mkdir -p ${TRUSTED_BIN_DIR} && ` +
          `ln -sf ${shellQuote(node)} ${TRUSTED_BIN_DIR}/node && ` +
          `ln -sf ${shellQuote(pnpm)} ${TRUSTED_BIN_DIR}/pnpm`,
        { timeout: 30_000 },
      ),
    );
    const environment = {
      PATH: `${TRUSTED_BIN_DIR}:${node.slice(0, node.lastIndexOf('/'))}:/usr/bin:/bin`,
      NODE_ENV: 'production',
    };
    for (const command of [
      `${shellQuote(node)} node_modules/@tanstack/router-cli/bin/tsr.cjs generate`,
      `${shellQuote(pnpm)} exec vite build --config vite.preview.config.mjs --base ${shellQuote(args.previewBasePath)}`,
    ]) {
      await requireSuccess(
        await runBoundedDeploymentBuildCommand(sandbox, command, {
          cwd: PROJECT_DIR,
          env: environment,
          timeout: BUILD_TIMEOUT_MS,
        }),
      );
    }
    await sandbox.killAllProcesses();
    const process = await sandbox.startProcess(
      `${shellQuote(pnpm)} exec vite preview --config vite.preview.config.mjs ` +
        `--host 0.0.0.0 --port ${BUILDER_PREVIEW_PORT} --strictPort`,
      {
        cwd: PROJECT_DIR,
        env: environment,
        timeout: BUILDER_PREVIEW_TTL_MS,
        autoCleanup: false,
        processId: 'ghostbuild-preview',
      },
    );
    await process.waitForPort(BUILDER_PREVIEW_PORT, {
      mode: 'http',
      status: { min: 200, max: 399 },
      timeout: PREVIEW_READY_TIMEOUT_MS,
    });
    await sandbox.setKeepAlive(true);
    lifecycle.stopHeartbeat();
  } catch (error) {
    await lifecycle.destroy();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.slice(-MAX_ERROR_BYTES) || 'The isolated preview build failed.', { cause: error });
  }
}

function requireExecutable(result: ExecResult, name: string): string {
  const executable = result.stdout.trim();
  if (!result.success || !/^\/[A-Za-z0-9._+/-]+$/.test(executable)) {
    throw new Error(`The isolated preview image does not provide a valid ${name} executable.`);
  }
  return executable;
}

function requireSuccess(result: ExecResult): void {
  if (!result.success) {
    throw new Error(`${result.stderr}\n${result.stdout}`.trim().slice(-MAX_ERROR_BYTES) || 'Isolated command failed.');
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
