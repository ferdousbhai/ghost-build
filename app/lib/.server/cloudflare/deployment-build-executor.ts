import { getSandbox, type ExecResult } from '@cloudflare/sandbox';
import type { DeploymentSandbox } from './deployment-sandbox';

const PROJECT_DIR = '/workspace/project';
const SOURCE_DIR = '/workspace/source';
const SOURCE_ARCHIVE = '/workspace/source.zip';
const BUILD_ARCHIVE = '/workspace/build.tar.gz';
const PACKAGE_DIR = '/workspace/package';
const MAX_ERROR_OUTPUT = 4_000;
const MAX_EXPANDED_KIB = 250 * 1024;
const MAX_EXPANDED_BYTES = MAX_EXPANDED_KIB * 1024;
const MAX_BUILD_PACKAGE_KIB = 300 * 1024;
const MAX_BUILD_ARCHIVE_BYTES = 50 * 1024 * 1024;
type BuildStage =
  | 'sandbox initialization'
  | 'source extraction'
  | 'dependency installation'
  | 'stack verification'
  | 'type checking'
  | 'application build'
  | 'linting'
  | 'build packaging'
  | 'build download';

export async function buildDeploymentSnapshot(args: {
  env: Env;
  deploymentId: string;
  snapshotKey: string;
  expectedSourceSha256: string;
}): Promise<Uint8Array<ArrayBuffer>> {
  if (!args.env.DeploymentSandbox) {
    throw new DeploymentBuildError('Deployment Sandbox binding is unavailable.');
  }
  const source = await args.env.APP_STORAGE.get(args.snapshotKey);
  if (!source) {
    throw new DeploymentBuildError('Deployment source snapshot is unavailable.');
  }
  if (!/^[a-f0-9]{64}$/.test(args.expectedSourceSha256)) {
    throw new DeploymentBuildError('Approved deployment source digest is invalid.');
  }

  const sandboxId = `build-${args.deploymentId}`.toLowerCase();
  const sandbox = getSandbox(args.env.DeploymentSandbox as DurableObjectNamespace<DeploymentSandbox>, sandboxId, {
    transport: 'rpc',
    enableDefaultSession: false,
    normalizeId: true,
  });
  let stage: BuildStage = 'sandbox initialization';
  try {
    await sandbox.mkdir(PROJECT_DIR, { recursive: true });
    await sandbox.mkdir(SOURCE_DIR, { recursive: true });
    await sandbox.writeFile(SOURCE_ARCHIVE, source.body);
    stage = 'source extraction';
    await requireSuccess(
      await sandbox.exec(`test "$(sha256sum ${SOURCE_ARCHIVE} | cut -d ' ' -f1)" = "${args.expectedSourceSha256}"`, {
        timeout: 30 * 1000,
      }),
    );
    await requireSuccess(
      await sandbox.exec(
        `test "$(unzip -p ${SOURCE_ARCHIVE} | head -c ${MAX_EXPANDED_BYTES + 1} | wc -c | tr -d ' ')" ` +
          `-le ${MAX_EXPANDED_BYTES}`,
        { timeout: 2 * 60 * 1000 },
      ),
    );
    await requireSuccess(await sandbox.exec(`unzip -q ${SOURCE_ARCHIVE} -d ${SOURCE_DIR}`, { timeout: 2 * 60 * 1000 }));
    await requireSuccess(
      await sandbox.exec(`test "$(du -sk ${SOURCE_DIR} | cut -f1)" -le ${MAX_EXPANDED_KIB}`, {
        timeout: 30 * 1000,
      }),
    );
    await requireSuccess(
      await sandbox.exec(
        `if [ -f ${SOURCE_DIR}/package.json ]; then cp -a ${SOURCE_DIR}/. ${PROJECT_DIR}/; ` +
          `elif [ -f ${SOURCE_DIR}/project/package.json ]; then cp -a ${SOURCE_DIR}/project/. ${PROJECT_DIR}/; ` +
          `else echo "Deployment snapshot does not contain package.json" >&2; exit 1; fi`,
      ),
    );
    stage = 'dependency installation';
    await requireSuccess(
      await sandbox.exec('pnpm install --frozen-lockfile --ignore-scripts=false', {
        cwd: PROJECT_DIR,
        timeout: 10 * 60 * 1000,
      }),
    );
    // Type checking regenerates deployment-owned artifacts such as
    // worker-configuration.d.ts and src/routeTree.gen.ts. A browser export may
    // legitimately omit either generated file, so prepare them before the
    // stack verifier enforces the complete production contract.
    for (const [command, scriptStage] of [
      ['run typecheck', 'type checking'],
      ['run verify:stack', 'stack verification'],
      ['run build', 'application build'],
      ['run lint', 'linting'],
    ] as const) {
      stage = scriptStage;
      await requireSuccess(await sandbox.exec(`pnpm ${command}`, { cwd: PROJECT_DIR, timeout: 10 * 60 * 1000 }));
    }
    stage = 'build packaging';
    await sandbox.mkdir(PACKAGE_DIR, { recursive: true });
    await requireSuccess(
      await sandbox.exec(
        `cp -a ${PROJECT_DIR}/dist ${PROJECT_DIR}/package.json ${PROJECT_DIR}/pnpm-lock.yaml ${PACKAGE_DIR}/ && ` +
          `if [ -d ${PROJECT_DIR}/migrations ]; then cp -a ${PROJECT_DIR}/migrations ${PACKAGE_DIR}/; fi`,
        { timeout: 2 * 60 * 1000 },
      ),
    );
    await requireSuccess(
      await sandbox.exec(
        `test "$(du -sk --apparent-size ${PACKAGE_DIR} | cut -f1)" -le ${MAX_BUILD_PACKAGE_KIB} && ` +
          `test -z "$(find ${PACKAGE_DIR} -type l -print -quit)"`,
        { timeout: 30 * 1000 },
      ),
    );
    await requireSuccess(
      await sandbox.exec(`tar -czf ${BUILD_ARCHIVE} -C ${PACKAGE_DIR} .`, { timeout: 2 * 60 * 1000 }),
    );
    await requireSuccess(
      await sandbox.exec(`test "$(stat -c %s ${BUILD_ARCHIVE})" -le ${MAX_BUILD_ARCHIVE_BYTES}`, {
        timeout: 30 * 1000,
      }),
    );
    stage = 'build download';
    const build = await new Response(await sandbox.readFileStream(BUILD_ARCHIVE)).arrayBuffer();
    return new Uint8Array(build);
  } catch (error) {
    throw new DeploymentBuildError(
      `The isolated production build failed during ${stage}: ${deploymentBuildErrorDetail(error)}`.slice(
        0,
        MAX_ERROR_OUTPUT,
      ),
      { cause: error },
    );
  } finally {
    await sandbox.destroy().catch((error) => console.error('Unable to destroy deployment build sandbox', error));
  }
}

function deploymentBuildErrorDetail(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current) && messages.length < 4) {
    seen.add(current);
    const message = current.message.trim();
    if (message && messages.at(-1) !== message) {
      messages.push(message);
    }
    current = current.cause;
  }
  return messages.join(' Caused by: ') || 'Unknown Sandbox error.';
}

class DeploymentBuildError extends Error {
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
