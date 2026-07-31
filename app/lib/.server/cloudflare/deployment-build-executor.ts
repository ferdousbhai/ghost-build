import {
  getSandbox,
  parseSSEStream,
  type ExecResult,
  type ISandbox,
  type LogEvent,
  type ProcessOptions,
} from '@cloudflare/sandbox';
import type { DeploymentSandbox } from './deployment-sandbox';
import { APP_AGENT_PROTECTED_FILE_SHA256 } from './deployment-security-baseline';
import type { DeploymentProjectProfile } from './deployment-snapshot';
import { trackSandboxLifecycle } from './sandbox-cleanup';
import { sandboxExec, withSandboxRpcTimeout } from './sandbox-lifecycle';

const PROJECT_DIR = '/workspace/project';
const SOURCE_DIR = '/workspace/source';
const SOURCE_ARCHIVE = '/workspace/source.zip';
const BUILD_ARCHIVE = '/workspace/build.tar.gz';
const PACKAGE_DIR = '/workspace/package';
const TRUSTED_BIN_DIR = '/workspace/ghostbuild-trusted-bin';
const TRUSTED_INPUT_DIR = '/workspace/ghostbuild-approved-inputs';
const MAX_ERROR_OUTPUT = 4_000;
export const MAX_DEPLOYMENT_BUILD_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const MAX_DEPLOYMENT_BUILD_COMMAND_EVENT_BYTES = MAX_DEPLOYMENT_BUILD_COMMAND_OUTPUT_BYTES * 6 + 64 * 1024;
const MAX_EXPANDED_KIB = 250 * 1024;
const MAX_EXPANDED_BYTES = MAX_EXPANDED_KIB * 1024;
const MAX_BUILD_PACKAGE_KIB = 300 * 1024;
const MAX_BUILD_ARCHIVE_BYTES = 50 * 1024 * 1024;
const BUILD_TIMEOUT_MS = {
  workspaceReset: 30_000,
  sourceDigest: 30_000,
  compressedSize: 60_000,
  extraction: 60_000,
  extractedSize: 30_000,
  sourceCopy: 30_000,
  workspacePolicy: 30_000,
  install: 4 * 60_000,
  typecheck: 3 * 60_000,
  stackVerification: 3 * 60_000,
  build: 4 * 60_000,
  lint: 2 * 60_000,
  packageCopy: 60_000,
  packageValidation: 30_000,
  archive: 60_000,
  archiveValidation: 30_000,
  download: 60_000,
} as const;
// Maximum aggregate command time for the longer App Agent web build path.
// Repeated generated typechecks and build verifiers must each be counted.
export const DEPLOYMENT_BUILD_STEP_BUDGET_MS =
  BUILD_TIMEOUT_MS.workspaceReset +
  BUILD_TIMEOUT_MS.workspacePolicy * 5 +
  BUILD_TIMEOUT_MS.sourceDigest +
  BUILD_TIMEOUT_MS.compressedSize +
  BUILD_TIMEOUT_MS.extraction +
  BUILD_TIMEOUT_MS.extractedSize +
  BUILD_TIMEOUT_MS.sourceCopy * 2 +
  BUILD_TIMEOUT_MS.packageValidation * 4 +
  BUILD_TIMEOUT_MS.install +
  BUILD_TIMEOUT_MS.typecheck * 3 +
  BUILD_TIMEOUT_MS.stackVerification +
  BUILD_TIMEOUT_MS.build * 3 +
  BUILD_TIMEOUT_MS.lint +
  BUILD_TIMEOUT_MS.packageCopy +
  BUILD_TIMEOUT_MS.archive +
  BUILD_TIMEOUT_MS.archiveValidation +
  BUILD_TIMEOUT_MS.download;
type BuildStage =
  | 'sandbox initialization'
  | 'source extraction'
  | 'workspace policy verification'
  | 'dependency installation'
  | 'stack verification'
  | 'type checking'
  | 'application build'
  | 'linting'
  | 'security boundary verification'
  | 'build packaging'
  | 'build download';

export async function buildDeploymentSnapshot(args: {
  env: Env;
  deploymentId: string;
  snapshotKey: string;
  expectedSourceSha256: string;
  project: DeploymentProjectProfile;
  validationOnly?: boolean;
  abortSignal?: AbortSignal;
}): Promise<Uint8Array<ArrayBuffer>> {
  args.abortSignal?.throwIfAborted();
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
  if (args.project.bindings.ai && !args.project.bindings.appAgent) {
    throw new DeploymentBuildError('Approved deployment profile contains an unmediated Workers AI binding.');
  }

  const sandboxId = `build-${args.deploymentId}`.toLowerCase();
  const sandbox = getSandbox(args.env.DeploymentSandbox as DurableObjectNamespace<DeploymentSandbox>, sandboxId, {
    transport: 'rpc',
    enableDefaultSession: false,
    normalizeId: true,
  });
  const lifecycle = await trackSandboxLifecycle({
    db: args.env.DB,
    sandbox,
    sandboxId,
    operation: 'deployment build sandbox',
  });
  let destroyPromise: Promise<void> | undefined;
  const destroySandbox = () => {
    destroyPromise ??= lifecycle.destroy();
    return destroyPromise;
  };
  const handleAbort = () => {
    void destroySandbox();
  };
  args.abortSignal?.addEventListener('abort', handleAbort, { once: true });
  let stage: BuildStage = 'sandbox initialization';
  try {
    args.abortSignal?.throwIfAborted();
    await requireSuccess(
      await sandboxExec(
        sandbox,
        `rm -rf ${PROJECT_DIR} ${SOURCE_DIR} ${SOURCE_ARCHIVE} ${BUILD_ARCHIVE} ${PACKAGE_DIR} ` +
          `${TRUSTED_BIN_DIR} ${TRUSTED_INPUT_DIR}`,
        { timeout: BUILD_TIMEOUT_MS.workspaceReset },
      ),
    );
    const systemNode = requireSystemExecutable(
      await sandboxExec(sandbox, 'command -v node', { timeout: BUILD_TIMEOUT_MS.workspacePolicy }),
      'Node.js',
    );
    const systemPnpm = requireSystemExecutable(
      await sandboxExec(sandbox, 'command -v pnpm', { timeout: BUILD_TIMEOUT_MS.workspacePolicy }),
      'pnpm',
    );
    await sandbox.mkdir(PROJECT_DIR, { recursive: true });
    await sandbox.mkdir(SOURCE_DIR, { recursive: true });
    await sandbox.writeFile(SOURCE_ARCHIVE, source.body);
    stage = 'source extraction';
    await requireSuccess(
      await sandboxExec(
        sandbox,
        `test "$(sha256sum ${SOURCE_ARCHIVE} | cut -d ' ' -f1)" = "${args.expectedSourceSha256}"`,
        {
          timeout: BUILD_TIMEOUT_MS.sourceDigest,
        },
      ),
    );
    await requireSuccess(
      await sandboxExec(
        sandbox,
        `test "$(unzip -p ${SOURCE_ARCHIVE} | head -c ${MAX_EXPANDED_BYTES + 1} | wc -c | tr -d ' ')" ` +
          `-le ${MAX_EXPANDED_BYTES}`,
        { timeout: BUILD_TIMEOUT_MS.compressedSize },
      ),
    );
    await requireSuccess(
      await sandboxExec(sandbox, `unzip -q ${SOURCE_ARCHIVE} -d ${SOURCE_DIR}`, {
        timeout: BUILD_TIMEOUT_MS.extraction,
      }),
    );
    await requireSuccess(
      await sandboxExec(sandbox, `test "$(du -sk ${SOURCE_DIR} | cut -f1)" -le ${MAX_EXPANDED_KIB}`, {
        timeout: BUILD_TIMEOUT_MS.extractedSize,
      }),
    );
    await requireSuccess(
      await sandboxExec(
        sandbox,
        `if [ -f ${SOURCE_DIR}/package.json ]; then cp -a ${SOURCE_DIR}/. ${PROJECT_DIR}/; ` +
          `elif [ -f ${SOURCE_DIR}/project/package.json ]; then cp -a ${SOURCE_DIR}/project/. ${PROJECT_DIR}/; ` +
          `else echo "Deployment snapshot does not contain package.json" >&2; exit 1; fi`,
        { timeout: BUILD_TIMEOUT_MS.sourceCopy },
      ),
    );
    stage = 'workspace policy verification';
    await requireSuccess(
      await sandboxExec(sandbox, 'ghostbuild-verify-pnpm-workspace pnpm-workspace.yaml', {
        cwd: PROJECT_DIR,
        timeout: BUILD_TIMEOUT_MS.workspacePolicy,
      }),
    );
    const approvedInputDigests = requireApprovedInputDigests(
      await sandboxExec(sandbox, 'sha256sum package.json pnpm-lock.yaml wrangler.jsonc pnpm-workspace.yaml', {
        cwd: PROJECT_DIR,
        timeout: BUILD_TIMEOUT_MS.workspacePolicy,
      }),
    );
    const requiresAppAgentSecurity = args.project.bindings.appAgent;
    const protectedFileDigests = requiresAppAgentSecurity ? APP_AGENT_PROTECTED_FILE_SHA256 : {};
    const projectBoundaryCheck = securityBoundaryVerificationCommand(approvedInputDigests, protectedFileDigests, '.');
    await requireSuccess(
      await sandboxExec(sandbox, projectBoundaryCheck, {
        cwd: PROJECT_DIR,
        timeout: BUILD_TIMEOUT_MS.packageValidation,
      }),
    );
    await requireSuccess(
      await sandboxExec(sandbox, trustedInputCopyCommand(protectedFileDigests), {
        cwd: PROJECT_DIR,
        timeout: BUILD_TIMEOUT_MS.sourceCopy,
      }),
    );
    const trustedBoundaryCheck = securityBoundaryVerificationCommand(
      approvedInputDigests,
      protectedFileDigests,
      TRUSTED_INPUT_DIR,
    );
    await requireSuccess(
      await sandboxExec(sandbox, trustedBoundaryCheck, {
        timeout: BUILD_TIMEOUT_MS.packageValidation,
      }),
    );
    stage = 'dependency installation';
    await requireSuccess(
      await sandboxExec(
        sandbox,
        `${shellQuote(systemPnpm)} install --frozen-lockfile --ignore-scripts=true --ignore-pnpmfile ` +
          '--registry=https://registry.npmjs.org/',
        { cwd: PROJECT_DIR, timeout: BUILD_TIMEOUT_MS.install },
      ),
    );
    await requireSuccess(
      await sandboxExec(
        sandbox,
        `rm -rf ${TRUSTED_BIN_DIR} && mkdir -p ${TRUSTED_BIN_DIR} && ` +
          `ln -s ${shellQuote(systemNode)} ${TRUSTED_BIN_DIR}/node && ` +
          `ln -s ${shellQuote(systemPnpm)} ${TRUSTED_BIN_DIR}/pnpm && ` +
          `ln -s ${PROJECT_DIR}/node_modules/wrangler/bin/wrangler.js ${TRUSTED_BIN_DIR}/wrangler`,
        { timeout: BUILD_TIMEOUT_MS.workspacePolicy },
      ),
    );
    const trustedEnv = {
      PATH: `${TRUSTED_BIN_DIR}:${systemNode.slice(0, systemNode.lastIndexOf('/'))}:/usr/bin:/bin`,
    };
    const verifiedEntrypoint = (command: string) => `${projectBoundaryCheck} && ${trustedBoundaryCheck} && ${command}`;
    // Type checking regenerates deployment-owned artifacts such as
    // worker-configuration.d.ts and src/routeTree.gen.ts. A browser export may
    // legitimately omit either generated file, so prepare them before the
    // stack verifier enforces the complete production contract.
    const webAppEntrypoints = [
      [
        `${shellQuote(systemNode)} ${TRUSTED_INPUT_DIR}/scripts/cf-typegen.mjs`,
        'type checking',
        BUILD_TIMEOUT_MS.typecheck,
      ],
      [
        `${shellQuote(systemNode)} node_modules/@tanstack/router-cli/bin/tsr.cjs generate`,
        'type checking',
        BUILD_TIMEOUT_MS.typecheck,
      ],
      [
        `${shellQuote(systemNode)} node_modules/typescript/bin/tsc -p . --noEmit --pretty false`,
        'type checking',
        BUILD_TIMEOUT_MS.typecheck,
      ],
      [
        `${shellQuote(systemNode)} scripts/verify-stack-alignment.mjs`,
        'stack verification',
        BUILD_TIMEOUT_MS.stackVerification,
      ],
      [`${shellQuote(systemNode)} scripts/verify-production-licenses.mjs`, 'application build', BUILD_TIMEOUT_MS.build],
      // pnpm supplies the generated shim's NODE_PATH, which Babel uses for virtual plugin resolution.
      [`${shellQuote(systemPnpm)} exec vite build`, 'application build', BUILD_TIMEOUT_MS.build],
      [
        `${shellQuote(systemNode)} scripts/verify-production-licenses.mjs --built`,
        'application build',
        BUILD_TIMEOUT_MS.build,
      ],
      [
        `${shellQuote(systemNode)} node_modules/eslint/bin/eslint.js src vite.config.ts ` +
          'scripts/verify-production-licenses.mjs scripts/lib/runtime-module-security.ts ' +
          'scripts/lib/production-license-artifact.mjs --max-warnings=0',
        'linting',
        BUILD_TIMEOUT_MS.lint,
      ],
    ] as const;
    const workerEntrypoints = [
      [`${shellQuote(systemPnpm)} run typecheck`, 'type checking', BUILD_TIMEOUT_MS.typecheck],
      [`${shellQuote(systemPnpm)} run verify:stack`, 'stack verification', BUILD_TIMEOUT_MS.stackVerification],
      [`${shellQuote(systemPnpm)} run build`, 'application build', BUILD_TIMEOUT_MS.build],
      [`${shellQuote(systemPnpm)} run lint`, 'linting', BUILD_TIMEOUT_MS.lint],
    ] as const;
    for (const [command, scriptStage, timeout] of requiresAppAgentSecurity ? webAppEntrypoints : workerEntrypoints) {
      stage = scriptStage;
      await requireSuccess(
        await runBoundedDeploymentBuildCommand(sandbox, verifiedEntrypoint(command), {
          cwd: PROJECT_DIR,
          env: trustedEnv,
          timeout,
        }),
      );
    }
    await sandbox.killAllProcesses();
    stage = 'security boundary verification';
    await requireSuccess(
      await sandboxExec(sandbox, `${projectBoundaryCheck} && ${trustedBoundaryCheck}`, {
        cwd: PROJECT_DIR,
        timeout: BUILD_TIMEOUT_MS.packageValidation,
      }),
    );
    if (args.validationOnly) {
      return new Uint8Array(0) as Uint8Array<ArrayBuffer>;
    }
    stage = 'build packaging';
    await sandbox.mkdir(PACKAGE_DIR, { recursive: true });
    await requireSuccess(
      await sandboxExec(
        sandbox,
        `cp -a ${PROJECT_DIR}/dist ${PROJECT_DIR}/package.json ${PROJECT_DIR}/pnpm-lock.yaml ${PACKAGE_DIR}/ && ` +
          `if [ -d ${PROJECT_DIR}/migrations ]; then cp -a ${PROJECT_DIR}/migrations ${PACKAGE_DIR}/; fi && ` +
          `if [ -d ${PROJECT_DIR}/agent-security-migrations ]; then ` +
          `cp -a ${PROJECT_DIR}/agent-security-migrations ${PACKAGE_DIR}/; fi`,
        { timeout: BUILD_TIMEOUT_MS.packageCopy },
      ),
    );
    await requireSuccess(
      await sandboxExec(
        sandbox,
        `test "$(du -sk --apparent-size ${PACKAGE_DIR} | cut -f1)" -le ${MAX_BUILD_PACKAGE_KIB} && ` +
          `test -z "$(find ${PACKAGE_DIR} -type l -print -quit)"`,
        { timeout: BUILD_TIMEOUT_MS.packageValidation },
      ),
    );
    await requireSuccess(
      await sandboxExec(sandbox, `tar -czf ${BUILD_ARCHIVE} -C ${PACKAGE_DIR} .`, {
        timeout: BUILD_TIMEOUT_MS.archive,
      }),
    );
    await requireSuccess(
      await sandboxExec(sandbox, `test "$(stat -c %s ${BUILD_ARCHIVE})" -le ${MAX_BUILD_ARCHIVE_BYTES}`, {
        timeout: BUILD_TIMEOUT_MS.archiveValidation,
      }),
    );
    stage = 'build download';
    const build = await withTimeout(
      new Response(
        (await sandbox.readFileStream(BUILD_ARCHIVE)).pipeThrough(limitBuildArchiveBytes(MAX_BUILD_ARCHIVE_BYTES)),
      ).arrayBuffer(),
      BUILD_TIMEOUT_MS.download,
      'Deployment build archive download timed out.',
    );
    return new Uint8Array(build);
  } catch (error) {
    args.abortSignal?.throwIfAborted();
    throw new DeploymentBuildError(
      `The isolated production build failed during ${stage}: ${deploymentBuildErrorDetail(error)}`.slice(
        0,
        MAX_ERROR_OUTPUT,
      ),
      { cause: error },
    );
  } finally {
    args.abortSignal?.removeEventListener('abort', handleAbort);
    await destroySandbox();
  }
}

const APPROVED_INPUT_PATHS = ['package.json', 'pnpm-lock.yaml', 'wrangler.jsonc', 'pnpm-workspace.yaml'] as const;

/** Run user-configurable Worker scripts without ever collecting unbounded command output in the Worker isolate. */
export async function runBoundedDeploymentBuildCommand(
  sandbox: Pick<ISandbox, 'startProcess' | 'streamProcessLogs' | 'killAllProcesses'>,
  command: string,
  options: Pick<ProcessOptions, 'cwd' | 'env'> & { timeout: number },
): Promise<ExecResult> {
  const startedAt = Date.now();
  const timestamp = new Date().toISOString();
  const process = await withSandboxRpcTimeout(
    sandbox.startProcess(command, { ...options, autoCleanup: false }),
    options.timeout,
    'Sandbox process start',
  );
  const stream = (
    await withSandboxRpcTimeout(sandbox.streamProcessLogs(process.id), 30_000, 'Sandbox process log connection')
  ).pipeThrough(limitBuildCommandEventBytes(MAX_DEPLOYMENT_BUILD_COMMAND_EVENT_BYTES));
  let outputBytes = 0;
  let stdout = '';
  let stderr = '';
  const collectResult = async (): Promise<ExecResult> => {
    for await (const event of parseSSEStream<LogEvent>(stream)) {
      if (event.type === 'stdout' || event.type === 'stderr') {
        const data = event.data ?? '';
        outputBytes += new TextEncoder().encode(data).byteLength;
        if (outputBytes > MAX_DEPLOYMENT_BUILD_COMMAND_OUTPUT_BYTES) {
          throw new DeploymentBuildError('Production build command output exceeds the 1 MiB limit.');
        }
        if (event.type === 'stdout') {
          stdout = appendOutputTail(stdout, data);
        } else {
          stderr = appendOutputTail(stderr, data);
        }
        continue;
      }
      if (event.type === 'exit') {
        const exitCode = event.exitCode ?? 1;
        return {
          success: exitCode === 0,
          exitCode,
          stdout,
          stderr,
          command,
          duration: Date.now() - startedAt,
          timestamp,
        };
      }
      if (event.type === 'error') {
        throw new DeploymentBuildError(
          event.data ? appendOutputTail('', event.data) : 'Production build command stream failed.',
        );
      }
    }
    throw new DeploymentBuildError('Production build command stream ended without an exit status.');
  };
  try {
    return await withSandboxRpcTimeout(collectResult(), options.timeout, 'Sandbox process log stream');
  } catch (error) {
    await Promise.allSettled([process.kill('SIGKILL'), sandbox.killAllProcesses()]);
    throw error;
  }
}

function appendOutputTail(current: string, next: string): string {
  return `${current}${next}`.slice(-MAX_ERROR_OUTPUT);
}

function limitBuildCommandEventBytes(maxBytes: number): TransformStream<Uint8Array, Uint8Array> {
  let receivedBytes = 0;
  return new TransformStream({
    transform(chunk, controller) {
      if (chunk.byteLength > maxBytes - receivedBytes) {
        throw new DeploymentBuildError('Production build command event stream exceeds its encoded size limit.');
      }
      receivedBytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
}

function requireSystemExecutable(result: ExecResult, name: string): string {
  if (!result.success) {
    throw new DeploymentBuildError(`The production build image does not provide ${name}.`);
  }
  const path = result.stdout.trim();
  if (!/^\/[A-Za-z0-9._+/-]+$/.test(path)) {
    throw new DeploymentBuildError(`The production build image returned an invalid ${name} path.`);
  }
  return path;
}

function requireApprovedInputDigests(result: ExecResult): ReadonlyMap<string, string> {
  if (!result.success) {
    throw new DeploymentBuildError('Unable to capture approved deployment build inputs.');
  }
  const digests = new Map<string, string>();
  for (const line of result.stdout.trim().split('\n')) {
    const match = /^([a-f0-9]{64})  (package\.json|pnpm-lock\.yaml|wrangler\.jsonc|pnpm-workspace\.yaml)$/.exec(line);
    if (!match || digests.has(match[2])) {
      throw new DeploymentBuildError('Approved deployment build input digests are invalid.');
    }
    digests.set(match[2], match[1]);
  }
  if (digests.size !== APPROVED_INPUT_PATHS.length) {
    throw new DeploymentBuildError('Approved deployment build input digests are incomplete.');
  }
  return digests;
}

function securityBoundaryVerificationCommand(
  approvedInputDigests: ReadonlyMap<string, string>,
  protectedFileDigests: Readonly<Record<string, string>>,
  root: string,
): string {
  const checks = [
    ...APPROVED_INPUT_PATHS.map((path) => exactFileDigestCheck(`${root}/${path}`, approvedInputDigests.get(path)!)),
    ...Object.entries(protectedFileDigests).map(([path, digest]) => exactFileDigestCheck(`${root}/${path}`, digest)),
  ];
  return checks.join(' && ');
}

function trustedInputCopyCommand(protectedFileDigests: Readonly<Record<string, string>>): string {
  const paths = [...APPROVED_INPUT_PATHS, ...Object.keys(protectedFileDigests)].toSorted();
  return (
    `rm -rf ${TRUSTED_INPUT_DIR} && mkdir -p ${TRUSTED_INPUT_DIR} && ` +
    `cp --parents ${paths.map(shellQuote).join(' ')} ${TRUSTED_INPUT_DIR} && ` +
    `ln -s ${PROJECT_DIR}/node_modules ${TRUSTED_INPUT_DIR}/node_modules && chmod -R a-w ${TRUSTED_INPUT_DIR}`
  );
}

function exactFileDigestCheck(path: string, digest: string): string {
  return `test "$(sha256sum ${shellQuote(path)} | cut -d ' ' -f1)" = "${digest}"`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new DeploymentBuildError(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function limitBuildArchiveBytes(maxBytes: number): TransformStream<Uint8Array, Uint8Array> {
  let receivedBytes = 0;
  return new TransformStream({
    transform(chunk, controller) {
      if (chunk.byteLength > maxBytes - receivedBytes) {
        throw new DeploymentBuildError('Deployment build archive exceeds the download size limit.');
      }
      receivedBytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
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
