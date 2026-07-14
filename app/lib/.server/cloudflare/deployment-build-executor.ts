import { getSandbox, type ExecResult } from '@cloudflare/sandbox';
import type { DeploymentSandbox } from './deployment-sandbox';

const PROJECT_DIR = '/workspace/project';
const SOURCE_ARCHIVE = '/workspace/source.tar.gz';
const BUILD_ARCHIVE = '/workspace/build.tar.gz';
const MAX_ERROR_OUTPUT = 4_000;

export async function buildDeploymentSnapshot(args: {
  env: Env;
  deploymentId: string;
  snapshotKey: string;
}): Promise<Uint8Array<ArrayBuffer>> {
  if (!args.env.DeploymentSandbox) {
    throw new DeploymentBuildError('Deployment Sandbox binding is unavailable.');
  }
  const source = await args.env.APP_STORAGE.get(args.snapshotKey);
  if (!source) {
    throw new DeploymentBuildError('Deployment source snapshot is unavailable.');
  }

  const sandboxId = `build-${args.deploymentId}`.toLowerCase();
  const sandbox = getSandbox(args.env.DeploymentSandbox as DurableObjectNamespace<DeploymentSandbox>, sandboxId, {
    transport: 'rpc',
    enableDefaultSession: false,
    normalizeId: true,
  });
  try {
    await sandbox.mkdir(PROJECT_DIR, { recursive: true });
    await sandbox.writeFile(SOURCE_ARCHIVE, source.body);
    await requireSuccess(await sandbox.exec(`tar -xzf ${SOURCE_ARCHIVE} -C ${PROJECT_DIR}`));
    await requireSuccess(
      await sandbox.exec('pnpm install --frozen-lockfile --ignore-scripts=false', {
        cwd: PROJECT_DIR,
        timeout: 10 * 60 * 1000,
      }),
    );
    for (const script of ['verify:stack', 'typecheck', 'build', 'lint']) {
      await requireSuccess(await sandbox.exec(`pnpm run ${script}`, { cwd: PROJECT_DIR, timeout: 10 * 60 * 1000 }));
    }
    await requireSuccess(
      await sandbox.exec(`tar -czf ${BUILD_ARCHIVE} -C ${PROJECT_DIR} dist migrations package.json pnpm-lock.yaml`, {
        timeout: 2 * 60 * 1000,
      }),
    );
    const build = await new Response(await sandbox.readFileStream(BUILD_ARCHIVE)).arrayBuffer();
    return new Uint8Array(build);
  } catch (error) {
    throw error instanceof DeploymentBuildError
      ? error
      : new DeploymentBuildError('The isolated production build failed.', { cause: error });
  } finally {
    await sandbox.destroy().catch((error) => console.error('Unable to destroy deployment build sandbox', error));
  }
}

export class DeploymentBuildError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DeploymentBuildError';
  }
}

async function requireSuccess(result: ExecResult): Promise<void> {
  if (result.success) {
    return;
  }
  const output = `${result.stderr}\n${result.stdout}`.trim().slice(-MAX_ERROR_OUTPUT);
  throw new DeploymentBuildError(
    output
      ? `Production build command failed (${result.exitCode}): ${output}`
      : `Production build command failed (${result.exitCode}).`,
  );
}
