import {
  type DurableObjectStorageLike,
  getWorkspace,
  type WorkspaceClient,
  type WorkspaceOptions,
  WorkspaceProxy,
  WorkspaceServiceProxy,
  withWorkspace,
} from '@cloudflare/computer';
import {
  CloudflareContainerBackend,
  type IWorkspaceContainerAPI,
  type WorkspaceRef,
} from '@cloudflare/computer/backends/container';
import { WorkerShellBackend } from '@cloudflare/computer/backends/worker-shell';
import { Sandbox } from '@cloudflare/sandbox';
import { parse } from 'jsonc-parser';
import { BuilderAgent } from '../../app/agents/builder-agent';
import { routeUserRuntimeAgentRequest } from '../../app/lib/.server/agent-request-identity';
import { createTrustedDeploymentConfig } from '../../app/lib/.server/cloudflare/deployment-config';
import { readUserWorkspaceRuntimeHealth } from '../../app/lib/.server/cloudflare/user-workspace-runtime-health';
import {
  DEPLOYMENT_PROJECT_ROOT,
  DEPLOYMENT_WRANGLER_CONFIG_PATH,
  DEPLOYMENT_WRANGLER_OUTPUT_PATH,
} from '../../app/lib/.server/cloudflare/deployment-runtime-policy';
import { addRequestedDependencies } from '../../app/lib/runtime/action-runner/dependency-manifest';
import {
  userRuntimeDataAction,
  userRuntimeInitialMessagesAction,
  userRuntimeStoreChatAction,
} from '../../app/lib/cloudflare/data.server';
import { verifyRuntimeCapability } from '../../app/lib/cloudflare/runtime-capability';
import { userRuntimeDeploymentAction } from '../../app/server-handlers/deployments';
import { userRuntimeEnhancePromptAction } from '../../app/server-handlers/enhance-prompt';
import { toolFailure, toolSuccess, type GhostbuildToolResult } from '../../ghostbuild-agent/tool-result';
import { openPreviewQuickTunnel } from './preview-tunnel';

export { WorkspaceProxy, WorkspaceServiceProxy };

interface RuntimeEnv {
  PROJECT_WORKSPACE: DurableObjectNamespace<ProjectWorkspace>;
  BuilderAgent: DurableObjectNamespace<BuilderAgent>;
  DB: D1Database;
  AI: Ai;
  LOADER: unknown;
  CONTROL_PLANE_SECRET: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;
  GHOSTBUILD_USER_ID: string;
  GHOSTBUILD_CONNECTION_ID: string;
  GHOSTBUILD_CONNECTION_GENERATION: string;
  GHOSTBUILD_USER_RUNTIME: string;
  GHOSTBUILD_USER_RUNTIME_ENDPOINT: string;
  GHOSTBUILD_RUNTIME_VERSION: string;
  SANDBOX_TRANSPORT: 'rpc';
}

const PROJECT_ROOT = DEPLOYMENT_PROJECT_ROOT;
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 10_000;
const SYNC_BATCH_BYTES = 4 * 1024 * 1024;
const SYNC_BATCH_FILES = 100;
const PROJECT_ID_PATTERN = /^[a-zA-Z0-9:_-]{1,256}$/;
const CHECKPOINT_EXCLUDED_ROOTS = new Set(['node_modules', 'dist', '.output', '.tanstack', '.wrangler']);
const DERIVED_PATHS = ['dist', '.output', '.tanstack', '.wrangler'].map((name) => `${PROJECT_ROOT}/${name}`);
const PREVIEW_PORT = 4173;
const PREVIEW_TTL_MS = 15 * 60_000;
const COMPUTERD_PROCESS_ID = 'ghostbuild-computerd';
const COMPUTERD_ROOT = '/tmp/ghostbuild-computer';
const COMPUTERD_BINARY = `${COMPUTERD_ROOT}/usr/local/bin/computerd`;
const COMPUTERD_LAYER_DIGEST = 'sha256:4034b86577bc36e9f089df87960e9249e1f05c77edaa52783da7d6142d07bb81';

type WorkspaceFile = {
  path: string;
  bytes: Uint8Array;
  size: number;
  mode: number;
  sha256: string;
};

type WorkspaceState = {
  initialized: boolean;
  revision: number;
  resetRevision: number;
  fileCount: number;
  totalBytes: number;
  seeding: boolean;
};

class ComputerSandboxBase extends Sandbox<RuntimeEnv> {
  readonly containerBackend = new CloudflareContainerBackend({
    container: () => this,
    workspace: { binding: 'PROJECT_WORKSPACE', id: this.ctx.id.toString() },
    containerEnv: { MOUNT_POINT: '/home', FUSE_MOUNT: 'auto' },
    connectTimeoutMs: 2 * 60_000,
    id: 'container-shell',
  });

  readonly workerShellBackend = new WorkerShellBackend({
    loader: this.env.LOADER as never,
    workspace: { binding: 'PROJECT_WORKSPACE', id: this.ctx.id.toString() },
    ctx: this.ctx,
    id: 'worker-shell',
  });

  readonly #computerHost = new SandboxComputerHost(this);

  getWorkspaceContainer(): IWorkspaceContainerAPI {
    return this.#computerHost;
  }

  async startComputerd(env: Record<string, string>): Promise<void> {
    const existing = await this.getProcess(COMPUTERD_PROCESS_ID).catch(() => null);
    if (existing && (existing.status === 'starting' || existing.status === 'running')) {
      return;
    }
    await this.cleanupCompletedProcesses().catch(() => undefined);
    const ready = await this.exec(`test -x ${shellQuote(COMPUTERD_BINARY)}`, { timeout: 30_000 });
    if (!ready.success) {
      requireSandboxExecSuccess(await this.exec(computerdBootstrapCommand(), { timeout: 5 * 60_000 }));
    }
    await this.startProcess(shellQuote(COMPUTERD_BINARY), {
      processId: COMPUTERD_PROCESS_ID,
      autoCleanup: false,
      env: { ...env, FUSE_MOUNT: 'auto' },
    });
  }

  async restartComputerd(env: Record<string, string>): Promise<void> {
    const existing = await this.getProcess(COMPUTERD_PROCESS_ID).catch(() => null);
    await existing?.kill('SIGKILL').catch(() => undefined);
    await this.exec('fusermount3 -uz /home >/dev/null 2>&1 || true', { timeout: 30_000 }).catch(() => undefined);
    await this.cleanupCompletedProcesses().catch(() => undefined);
    await this.startComputerd(env);
  }

  async computerdStatus(): Promise<{ running: boolean; exit: { exitedAt: number; reason: string } | null }> {
    const process = await this.getProcess(COMPUTERD_PROCESS_ID).catch(() => null);
    if (!process) {
      return { running: false, exit: null };
    }
    const status = await process.getStatus().catch(() => process.status);
    const running = status === 'starting' || status === 'running';
    return {
      running,
      exit: running
        ? null
        : {
            exitedAt: process.endTime?.getTime() ?? Date.now(),
            reason: `computerd ${status}${process.exitCode === undefined ? '' : ` (${process.exitCode})`}`,
          },
    };
  }

  interceptWorkspaceOutbound(host: string, ref: WorkspaceRef): Promise<void> {
    const exports = this.ctx.exports as unknown as {
      WorkspaceProxy(options: { props: WorkspaceRef }): Fetcher;
    };
    return this.ctx.container!.interceptOutboundHttp(host, exports.WorkspaceProxy({ props: ref }));
  }

  fetchComputerPort(port: number, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return this.ctx.container!.getTcpPort(port).fetch(input, init);
  }

  computerPort(port: number): Fetcher {
    return this.ctx.container!.getTcpPort(port);
  }
}

class SandboxComputerHost implements IWorkspaceContainerAPI {
  constructor(private readonly sandbox: ComputerSandboxBase) {}

  start(env: Record<string, string>): Promise<void> {
    return this.sandbox.startComputerd(env);
  }

  restart(env: Record<string, string>): Promise<void> {
    return this.sandbox.restartComputerd(env);
  }

  interceptOutboundHttp(host: string, workspace: WorkspaceRef): Promise<void> {
    return this.sandbox.interceptWorkspaceOutbound(host, workspace);
  }

  fetchPort(port: number, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return this.sandbox.fetchComputerPort(port, input, init);
  }

  port(port: number): Fetcher {
    return this.sandbox.computerPort(port);
  }

  status() {
    return this.sandbox.computerdStatus();
  }

  async exitInfo() {
    return (await this.sandbox.computerdStatus()).exit;
  }
}

function computerWorkspaceOptions(self: InstanceType<typeof ComputerSandboxBase>): WorkspaceOptions {
  const { ctx } = self as unknown as { ctx: DurableObjectState };
  return {
    storage: ctx.storage as unknown as DurableObjectStorageLike,
    backends: [self.workerShellBackend, self.containerBackend],
    waitUntil: (promise) => ctx.waitUntil(promise),
  };
}

export class ProjectWorkspace extends withWorkspace(ComputerSandboxBase, computerWorkspaceOptions) {
  constructor(ctx: DurableObjectState<{}>, env: RuntimeEnv) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ghostbuild_workspace_state (
         singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
         initialized INTEGER NOT NULL DEFAULT 0,
         seed_id TEXT,
         reset_revision INTEGER NOT NULL DEFAULT 0,
         preview_id TEXT,
         preview_exec_id TEXT
       )`,
    );
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO ghostbuild_workspace_state (singleton, initialized, reset_revision)
       VALUES (1, 0, 0)`,
    );
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ghostbuild_validations (
         revision TEXT PRIMARY KEY,
         workspace_revision INTEGER NOT NULL,
         validated_at INTEGER NOT NULL
       )`,
    );
  }

  override fetch(request: Request): Promise<Response> {
    return this.containerBackend.handleFetch(request);
  }

  async getWorkspaceState(): Promise<WorkspaceState> {
    return this.withComputer(async (workspace) => this.stateFromFiles(await readProjectFiles(workspace)));
  }

  async beginSeed(seedIdValue: unknown) {
    const seedId = requireString(seedIdValue, 'seedId', 256);
    const row = this.workspaceRow();
    if (row.initialized === 1) {
      return { status: 'initialized' as const, state: await this.getWorkspaceState() };
    }
    if (row.seed_id === seedId) {
      return { status: 'seeding' as const, state: await this.getWorkspaceState() };
    }
    await this.withComputer(async (workspace) => {
      await workspace.fs.rm(PROJECT_ROOT, { recursive: true, force: true });
      await workspace.fs.mkdir(PROJECT_ROOT, { recursive: true });
    });
    this.ctx.storage.sql.exec(
      `UPDATE ghostbuild_workspace_state
       SET initialized = 0, seed_id = ?, reset_revision = ?
       WHERE singleton = 1`,
      seedId,
      this.currentRevision(),
    );
    return { status: 'started' as const, seedId, state: await this.getWorkspaceState() };
  }

  async appendSeed(seedIdValue: unknown, entriesValue: unknown) {
    const seedId = requireString(seedIdValue, 'seedId', 256);
    if (this.workspaceRow().seed_id !== seedId) {
      throw new Error('The workspace seed is no longer active.');
    }
    const entries = requireFileInputs(entriesValue);
    await this.withComputer(async (workspace) => {
      for (const entry of entries) {
        await writeWorkspaceFile(workspace, entry.path, decodeFileContent(entry.content, entry.encoding));
      }
    });
    return this.getWorkspaceState();
  }

  async commitSeed(seedIdValue: unknown, expectedValue: unknown) {
    const seedId = requireString(seedIdValue, 'seedId', 256);
    if (this.workspaceRow().seed_id !== seedId) {
      throw new Error('The workspace seed is no longer active.');
    }
    const expected = record(expectedValue);
    const expectedFiles = requireInteger(expected.fileCount, 'fileCount', MAX_FILES);
    const expectedBytes = requireInteger(expected.totalBytes, 'totalBytes', MAX_TOTAL_BYTES);
    const files = await this.withComputer(readProjectFiles);
    if (files.length !== expectedFiles || totalFileBytes(files) !== expectedBytes) {
      throw new Error('The workspace seed did not match the expected template.');
    }
    const revision = this.currentRevision();
    this.ctx.storage.sql.exec(
      `UPDATE ghostbuild_workspace_state
       SET initialized = 1, seed_id = NULL, reset_revision = ?
       WHERE singleton = 1`,
      revision,
    );
    return this.stateFromFiles(files);
  }

  async abortSeed(seedIdValue: unknown) {
    const seedId = requireString(seedIdValue, 'seedId', 256);
    if (this.workspaceRow().seed_id === seedId) {
      await this.withComputer((workspace) => workspace.fs.rm(PROJECT_ROOT, { recursive: true, force: true }));
      this.ctx.storage.sql.exec(
        `UPDATE ghostbuild_workspace_state SET initialized = 0, seed_id = NULL, reset_revision = ? WHERE singleton = 1`,
        this.currentRevision(),
      );
    }
    return this.getWorkspaceState();
  }

  async applyChanges(value: unknown) {
    const input = record(value);
    const baseRevision = requireInteger(input.baseRevision, 'baseRevision', Number.MAX_SAFE_INTEGER);
    const changes = requireChanges(input.changes);
    if (baseRevision !== this.currentRevision()) {
      return { ok: false as const, conflict: true as const, state: await this.getWorkspaceState() };
    }
    const existingFiles = await this.withComputer(readProjectFiles);
    if (baseRevision !== this.currentRevision()) {
      return { ok: false as const, conflict: true as const, state: await this.getWorkspaceState() };
    }
    const projectedFiles = new Map(existingFiles.map((file) => [file.path, { size: file.size, mode: file.mode }]));
    const decodedWrites = new Map<string, { bytes: Uint8Array; mode?: number }>();
    for (const change of changes) {
      if (change.kind === 'delete') {
        for (const path of projectedFiles.keys()) {
          if (path === change.path || path.startsWith(`${change.path}/`)) projectedFiles.delete(path);
        }
        continue;
      }
      const bytes = decodeFileContent(change.content, change.encoding);
      if (bytes.byteLength > MAX_FILE_BYTES) {
        throw new Error(`Workspace file exceeds ${MAX_FILE_BYTES} bytes.`);
      }
      const mode = change.mode ?? projectedFiles.get(change.path)?.mode;
      decodedWrites.set(change.path, { bytes, mode });
      projectedFiles.set(change.path, { size: bytes.byteLength, mode: mode ?? 0o644 });
    }
    if (
      projectedFiles.size > MAX_FILES ||
      [...projectedFiles.values()].reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL_BYTES
    ) {
      throw new Error('The project workspace exceeds its size limit.');
    }
    const changedPaths: string[] = [];
    await this.withComputer(async (workspace) => {
      for (const change of changes) {
        if (change.kind === 'delete') {
          await workspace.fs.rm(change.path, { recursive: true, force: true });
        } else {
          const write = decodedWrites.get(change.path)!;
          await writeWorkspaceFile(workspace, change.path, write.bytes, true, write.mode);
        }
        changedPaths.push(change.path);
      }
    });
    const state = await this.getWorkspaceState();
    return { ok: true as const, state, changedPaths };
  }

  async getSyncPage(value: unknown) {
    const input = record(value);
    const fromRevision = requireInteger(input.fromRevision, 'fromRevision', Number.MAX_SAFE_INTEGER);
    const cursor = typeof input.cursor === 'string' ? decodeSyncCursor(input.cursor) : null;
    const targetRevision = cursor?.revision ?? this.currentRevision();
    const state = await this.getWorkspaceState();
    if (state.revision !== targetRevision) {
      return {
        state,
        fromRevision,
        targetRevision: state.revision,
        mode: 'snapshot' as const,
        entries: [],
        restart: true,
      };
    }
    if (!cursor && fromRevision === targetRevision) {
      return { state, fromRevision, targetRevision, mode: 'current' as const, entries: [] };
    }
    const files = await this.withComputer(readProjectFiles);
    const observedRevision = this.currentRevision();
    if (observedRevision !== targetRevision) {
      const currentState = await this.getWorkspaceState();
      return {
        state: currentState,
        fromRevision,
        targetRevision: currentState.revision,
        mode: 'snapshot' as const,
        entries: [],
        restart: true,
      };
    }
    const start = cursor?.index ?? 0;
    const page: WorkspaceFile[] = [];
    let bytes = 0;
    for (const file of files.slice(start)) {
      if (page.length >= SYNC_BATCH_FILES || (page.length > 0 && bytes + file.size > SYNC_BATCH_BYTES)) {
        break;
      }
      page.push(file);
      bytes += file.size;
    }
    const nextIndex = start + page.length;
    return {
      state,
      fromRevision,
      targetRevision,
      mode: 'snapshot' as const,
      entries: page.map((file) => fileSyncEntry(file, targetRevision)),
      ...(nextIndex < files.length
        ? { nextCursor: encodeSyncCursor({ revision: targetRevision, index: nextIndex }) }
        : {}),
    };
  }

  async readText(pathValue: unknown) {
    const path = requireProjectPath(pathValue);
    const file = await this.withComputer((workspace) => readWorkspaceFile(workspace, path));
    const content = decodeUtf8(file.bytes);
    return {
      path,
      content,
      encoding: 'utf8' as const,
      size: file.size,
      sha256: file.sha256,
      revision: this.currentRevision(),
    };
  }

  async readWorkspaceFile(pathValue: unknown) {
    const path = requireProjectPath(pathValue);
    const file = await this.withComputer((workspace) => readWorkspaceFile(workspace, path));
    return {
      path,
      bytes: file.bytes,
      encoding: canDecodeUtf8(file.bytes) ? ('utf8' as const) : ('base64' as const),
      size: file.size,
      mode: file.mode,
      sha256: file.sha256,
      revision: this.currentRevision(),
    };
  }

  async streamWorkspaceFile(pathValue: unknown): Promise<ReadableStream<Uint8Array>> {
    const path = requireProjectPath(pathValue);
    const workspace = await getWorkspace(this as unknown as Parameters<typeof getWorkspace>[0]);
    try {
      const stat = await workspace.fs.stat(path);
      if (!stat.isFile || stat.size > MAX_FILE_BYTES) {
        throw new Error(`Workspace file is invalid or too large: ${path}`);
      }
      const reader = (await workspace.fs.readFile(path)).getReader();
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        reader.releaseLock();
        workspace[Symbol.dispose]();
      };
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { value, done } = await reader.read();
            if (done) {
              dispose();
              controller.close();
            } else {
              controller.enqueue(value);
            }
          } catch (error) {
            dispose();
            controller.error(error);
          }
        },
        async cancel(reason) {
          try {
            await reader.cancel(reason);
          } finally {
            dispose();
          }
        },
      });
    } catch (error) {
      workspace[Symbol.dispose]();
      throw error;
    }
  }

  async listWorkspaceFiles() {
    const revision = this.currentRevision();
    return (await this.withComputer(readProjectFiles)).map((file) => ({
      path: file.path,
      encoding: canDecodeUtf8(file.bytes) ? ('utf8' as const) : ('base64' as const),
      size: file.size,
      mode: file.mode,
      sha256: file.sha256,
      revision,
    }));
  }

  async readDirectory(pathValue: unknown) {
    const path = requireProjectPath(pathValue, true);
    return this.withComputer(async (workspace) =>
      (await workspace.fs.readdir(path)).map((entry) => ({
        name: entry.name,
        isFile: entry.isFile,
        isDirectory: entry.isDirectory,
      })),
    );
  }

  async makeDirectory(pathValue: unknown) {
    const path = requireProjectPath(pathValue, true);
    await this.withComputer((workspace) => workspace.fs.mkdir(path, { recursive: true }));
  }

  async execute(value: unknown) {
    const input = record(value);
    const command = requireString(input.command, 'command', 64 * 1024);
    const cwd = input.cwd === undefined ? PROJECT_ROOT : requireProjectPath(input.cwd, true);
    const backend = requireBackend(input.backend);
    return this.withComputer((workspace) => runCommand(workspace, command, { cwd, backend, timeoutMs: 5 * 60_000 }));
  }

  async checkpoint() {
    const initialRevision = this.currentRevision();
    const files = await this.withComputer(readProjectFiles);
    const revision = await sha256Text(
      JSON.stringify(files.map((file) => [relativeProjectPath(file.path), file.mode, file.sha256])),
    );
    if (this.currentRevision() !== initialRevision) {
      throw new Error('The project workspace changed while its checkpoint was created.');
    }
    return { workspaceRevision: initialRevision, revision };
  }

  async installDependenciesTool(value: unknown): Promise<GhostbuildToolResult> {
    const input = record(value);
    const mode = input.mode === 'sync-lockfile' ? 'sync-lockfile' : input.mode === 'add' ? 'add' : null;
    const packages = requireStringArray(input.packages, 'packages', 100);
    if (!mode) {
      throw new SyntaxError('Invalid dependency installation mode.');
    }
    const startedAt = Date.now();
    await this.withComputer(async (workspace) => {
      const packagePath = `${PROJECT_ROOT}/package.json`;
      const current = decodeUtf8((await readWorkspaceFile(workspace, packagePath)).bytes);
      const next = mode === 'sync-lockfile' ? current : addRequestedDependencies(current, packages);
      await writeWorkspaceFile(workspace, packagePath, new TextEncoder().encode(next));
      requireCommandSuccess(
        await runCommand(
          workspace,
          'pnpm install --lockfile-only --ignore-scripts=true --ignore-pnpmfile --registry=https://registry.npmjs.org/',
          { cwd: PROJECT_ROOT, backend: 'container-shell', timeoutMs: 4 * 60_000 },
        ),
      );
    });
    const state = await this.getWorkspaceState();
    return toolSuccess(
      mode === 'sync-lockfile'
        ? 'Synchronized the durable project lockfile with package.json.'
        : `Installed ${packages.length} dependency package${packages.length === 1 ? '' : 's'} in the durable project.`,
      {
        mode,
        workspaceRevision: state.revision,
        buildEnvironment: 'cloudflare-computer-container',
        durationMs: Date.now() - startedAt,
      },
    );
  }

  async validateTool(): Promise<GhostbuildToolResult> {
    const before = await this.checkpoint();
    const startedAt = Date.now();
    try {
      await this.withComputer(async (workspace) => {
        requireCommandSuccess(
          await runCommand(
            workspace,
            'pnpm install --frozen-lockfile --ignore-scripts=true --ignore-pnpmfile --registry=https://registry.npmjs.org/',
            { cwd: PROJECT_ROOT, backend: 'container-shell', timeoutMs: 4 * 60_000 },
          ),
        );
        for (const command of ['pnpm run typecheck', 'pnpm run verify:stack', 'pnpm run build', 'pnpm run lint']) {
          requireCommandSuccess(
            await runCommand(workspace, command, {
              cwd: PROJECT_ROOT,
              backend: 'container-shell',
              timeoutMs: 5 * 60_000,
            }),
          );
        }
        await removeDerivedFiles(workspace);
      });
      const after = await this.checkpoint();
      if (after.revision !== before.revision) {
        throw new Error('The project changed while validation was running. Validate the new revision.');
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO ghostbuild_validations (revision, workspace_revision, validated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(revision) DO UPDATE SET workspace_revision = excluded.workspace_revision,
           validated_at = excluded.validated_at`,
        after.revision,
        after.workspaceRevision,
        Date.now(),
      );
      return toolSuccess(`Project validation passed at durable source revision ${after.revision}.`, {
        level: 'full',
        revision: after.revision,
        workspaceRevision: after.workspaceRevision,
        buildEnvironment: 'cloudflare-computer-container',
        checks: ['workspace-policy', 'dependency-installation', 'typecheck', 'stack-verification', 'build', 'lint'].map(
          (name) => ({ name, status: 'passed' as const }),
        ),
        durationMs: Date.now() - startedAt,
        nextAction: 'prepare-deployment',
      });
    } catch (error) {
      return toolFailure(error instanceof Error ? error.message.slice(-4_000) : 'User-owned validation failed.', {
        level: 'full',
        revision: before.revision,
        workspaceRevision: before.workspaceRevision,
        currentWorkspaceRevision: this.currentRevision(),
        buildEnvironment: 'cloudflare-computer-container',
        checks: [{ name: 'production-build', status: 'failed' as const }],
      });
    }
  }

  validationStatus(revision: unknown) {
    return { valid: typeof revision === 'string' && this.hasSuccessfulValidation(revision) };
  }

  async deploymentPlan(revisionValue: unknown) {
    const revision = requireString(revisionValue, 'revision', 64);
    if (!this.hasSuccessfulValidation(revision)) {
      throw new Error('Deployment requires successful validation of this exact revision.');
    }
    const checkpoint = await this.checkpoint();
    if (checkpoint.revision !== revision) {
      throw new Error('The durable project changed after validation. Run full validation again.');
    }
    const [packageFile, wranglerFile] = await Promise.all([
      this.readText(`${PROJECT_ROOT}/package.json`),
      this.readText(`${PROJECT_ROOT}/wrangler.jsonc`),
    ]);
    const packageJson = JSON.parse(packageFile.content) as { ghostbuild?: { projectType?: unknown } };
    const configuredType = packageJson.ghostbuild?.projectType;
    if (configuredType !== undefined && configuredType !== 'web_app' && configuredType !== 'worker') {
      throw new Error('The generated project type is invalid.');
    }
    const wrangler = parse(wranglerFile.content) as Record<string, unknown> | undefined;
    if (!wrangler || wrangler.main !== 'src/server.ts') {
      throw new Error('The generated Worker entrypoint is invalid.');
    }
    const hasArrayBinding = (value: unknown, binding: string) =>
      Array.isArray(value) && value.some((entry) => recordOrNull(entry)?.binding === binding);
    return {
      ...checkpoint,
      project: {
        type: configuredType === 'worker' ? ('worker' as const) : ('web_app' as const),
        bindings: {
          ai: recordOrNull(wrangler.ai)?.binding === 'AI',
          d1: hasArrayBinding(wrangler.d1_databases, 'DB'),
          r2: hasArrayBinding(wrangler.r2_buckets, 'APP_STORAGE'),
          appAgent:
            Array.isArray(recordOrNull(wrangler.durable_objects)?.bindings) &&
            (recordOrNull(wrangler.durable_objects)?.bindings as unknown[]).some(
              (entry) => recordOrNull(entry)?.name === 'AppAgent',
            ),
        },
      },
    };
  }

  async createPreview(value: unknown) {
    const previewId = requireString(record(value).previewId, 'previewId', 128);
    const checkpoint = await this.checkpoint();
    await this.stopActivePreview();
    await this.withComputer(async (workspace) => {
      requireCommandSuccess(
        await runCommand(workspace, 'pnpm exec vite build --config vite.preview.config.mjs', {
          cwd: PROJECT_ROOT,
          backend: 'container-shell',
          timeoutMs: 5 * 60_000,
        }),
      );
      const execId = `preview-${previewId}`;
      await workspace.runtime.disposeExec(execId, { backend: 'container-shell' }).catch(() => undefined);
      const handle = await workspace.runtime.exec(
        `pnpm exec vite preview --config vite.preview.config.mjs --host 0.0.0.0 --port ${PREVIEW_PORT} --strictPort`,
        {
          cwd: PROJECT_ROOT,
          backend: 'container-shell',
          id: execId,
          timeoutMs: PREVIEW_TTL_MS,
          encoding: 'utf8',
        },
      );
      handle[Symbol.dispose]();
      this.ctx.storage.sql.exec(
        `UPDATE ghostbuild_workspace_state SET preview_id = ?, preview_exec_id = ? WHERE singleton = 1`,
        previewId,
        execId,
      );
    });
    await waitForHttpPort(this.ctx.container!.getTcpPort(PREVIEW_PORT));
    await this.setKeepAlive(true);
    const tunnel = await openPreviewQuickTunnel(this.tunnels, PREVIEW_PORT);
    await this.schedule(PREVIEW_TTL_MS / 1_000, 'expirePreview', { previewId });
    const now = Date.now();
    return {
      id: previewId,
      url: tunnel.url,
      workspaceRevision: checkpoint.workspaceRevision,
      snapshotRevision: checkpoint.revision,
      readyAt: new Date(now).toISOString(),
      expiresAt: new Date(now + PREVIEW_TTL_MS).toISOString(),
    };
  }

  async stopPreview(previewIdValue: unknown) {
    const previewId = requireString(previewIdValue, 'previewId', 128);
    const row = this.workspaceRow();
    if (row.preview_id === previewId) {
      await this.stopActivePreview();
    }
  }

  async expirePreview(value: unknown) {
    await this.stopPreview(record(value).previewId);
  }

  async deploy(value: unknown) {
    const input = record(value);
    const revision = requireString(input.revision, 'revision', 64);
    if (!/^[a-f0-9]{64}$/.test(revision) || !this.hasSuccessfulValidation(revision)) {
      throw new Error('Deployment requires successful validation of this exact revision.');
    }
    if ((await this.checkpoint()).revision !== revision) {
      throw new Error('The durable project changed after validation. Run full validation again.');
    }
    const apiToken = requireString(input.apiToken, 'apiToken', 4096);
    const accountId = requireString(input.accountId, 'accountId', 64);
    const workerName = requireCloudflareName(input.workerName, 'workerName');
    const projectType = input.projectType === 'worker' ? 'worker' : input.projectType === 'web_app' ? 'web_app' : null;
    if (!projectType) {
      throw new SyntaxError('Invalid deployment project type.');
    }
    return this.withComputer(async (workspace) => {
      for (const command of ['pnpm run typecheck', 'pnpm run verify:stack', 'pnpm run build', 'pnpm run lint']) {
        requireCommandSuccess(
          await runCommand(workspace, command, {
            cwd: PROJECT_ROOT,
            backend: 'container-shell',
            timeoutMs: 5 * 60_000,
          }),
        );
      }
      const configPath = DEPLOYMENT_WRANGLER_CONFIG_PATH;
      const outputPath = DEPLOYMENT_WRANGLER_OUTPUT_PATH;
      await writeWorkspaceFile(
        workspace,
        configPath,
        new TextEncoder().encode(
          JSON.stringify(createTrustedDeploymentConfig({ ...input, accountId, workerName, projectType })),
        ),
        false,
      );
      const env = {
        CLOUDFLARE_ACCOUNT_ID: accountId,
        CLOUDFLARE_API_TOKEN: apiToken,
        WRANGLER_OUTPUT_FILE_PATH: outputPath,
      };
      try {
        if (typeof input.d1DatabaseId === 'string') {
          requireCommandSuccess(
            await runCommand(
              workspace,
              `pnpm exec wrangler d1 migrations apply DB --remote --config ${configPath} --yes`,
              {
                cwd: PROJECT_ROOT,
                backend: 'container-shell',
                timeoutMs: 5 * 60_000,
                env,
              },
            ),
          );
        }
        if (typeof input.agentSecurityD1DatabaseId === 'string') {
          requireCommandSuccess(
            await runCommand(
              workspace,
              `pnpm exec wrangler d1 migrations apply AGENT_SECURITY_DB --remote --config ${configPath} --yes`,
              { cwd: PROJECT_ROOT, backend: 'container-shell', timeoutMs: 5 * 60_000, env },
            ),
          );
        }
        requireCommandSuccess(
          await runCommand(workspace, `pnpm exec wrangler deploy --config ${configPath}`, {
            cwd: PROJECT_ROOT,
            backend: 'container-shell',
            timeoutMs: 10 * 60_000,
            env,
          }),
        );
        const output = decodeUtf8((await readWorkspaceFile(workspace, outputPath)).bytes);
        return { workerName, workerVersionId: parseWranglerVersion(output, workerName) };
      } finally {
        await workspace.fs.rm(configPath, { force: true }).catch(() => undefined);
        await workspace.fs.rm(outputPath, { force: true }).catch(() => undefined);
        await removeDerivedFiles(workspace);
      }
    });
  }

  async deleteProject() {
    await this.stopActivePreview();
    await this.withComputer((workspace) => workspace.fs.rm(PROJECT_ROOT, { recursive: true, force: true }));
    this.ctx.storage.sql.exec('DELETE FROM ghostbuild_validations');
    this.ctx.storage.sql.exec(
      `UPDATE ghostbuild_workspace_state
       SET initialized = 0, seed_id = NULL, reset_revision = ?, preview_id = NULL, preview_exec_id = NULL
       WHERE singleton = 1`,
      this.currentRevision(),
    );
    await this.destroy().catch(() => undefined);
  }

  private async stopActivePreview() {
    const row = this.workspaceRow();
    this.deleteSchedules('expirePreview');
    if (row.preview_exec_id) {
      await this.withComputer(async (workspace) => {
        await workspace.runtime
          .killExec(row.preview_exec_id!, { backend: 'container-shell', signal: 'SIGKILL' })
          .catch(() => undefined);
        await workspace.runtime
          .disposeExec(row.preview_exec_id!, { backend: 'container-shell' })
          .catch(() => undefined);
        await removeDerivedFiles(workspace);
      });
    }
    await this.tunnels.destroy(PREVIEW_PORT).catch(() => undefined);
    await this.setKeepAlive(false).catch(() => undefined);
    this.ctx.storage.sql.exec(
      'UPDATE ghostbuild_workspace_state SET preview_id = NULL, preview_exec_id = NULL WHERE singleton = 1',
    );
  }

  private hasSuccessfulValidation(revision: string): boolean {
    return (
      first(
        this.ctx.storage.sql.exec<{ found: number }>(
          'SELECT 1 AS found FROM ghostbuild_validations WHERE revision = ? LIMIT 1',
          revision,
        ),
      )?.found === 1
    );
  }

  private currentRevision(): number {
    return first(this.ctx.storage.sql.exec<{ v: number }>("SELECT v FROM vfs_meta WHERE k = 'rev'"))?.v ?? 0;
  }

  private workspaceRow(): {
    initialized: number;
    seed_id: string | null;
    reset_revision: number;
    preview_id: string | null;
    preview_exec_id: string | null;
  } {
    const row = first(
      this.ctx.storage.sql.exec<{
        initialized: number;
        seed_id: string | null;
        reset_revision: number;
        preview_id: string | null;
        preview_exec_id: string | null;
      }>(
        `SELECT initialized, seed_id, reset_revision, preview_id, preview_exec_id
         FROM ghostbuild_workspace_state WHERE singleton = 1`,
      ),
    );
    if (!row) {
      throw new Error('The Computer workspace state is unavailable.');
    }
    return row;
  }

  private stateFromFiles(files: WorkspaceFile[]): WorkspaceState {
    const row = this.workspaceRow();
    return {
      initialized: row.initialized === 1,
      revision: this.currentRevision(),
      resetRevision: row.reset_revision,
      fileCount: files.length,
      totalBytes: totalFileBytes(files),
      seeding: row.seed_id !== null,
    };
  }

  private async withComputer<T>(operation: (workspace: WorkspaceClient) => Promise<T>): Promise<T> {
    const workspace = await getWorkspace(this as unknown as Parameters<typeof getWorkspace>[0]);
    try {
      return await operation(workspace);
    } finally {
      workspace[Symbol.dispose]();
    }
  }
}

export default {
  async fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const controlPlaneRequest = authorized(request, env.CONTROL_PLANE_SECRET);
    if (controlPlaneRequest && request.method === 'GET' && url.pathname === '/v1/health') {
      try {
        return Response.json(await readUserWorkspaceRuntimeHealth(env), {
          headers: { 'cache-control': 'no-store' },
        });
      } catch {
        return Response.json(
          { ok: false, service: 'ghostbuild-user-workspace-runtime' },
          { status: 503, headers: { 'cache-control': 'no-store' } },
        );
      }
    }
    const route = parseProjectRoute(url.pathname);
    if (!route || !controlPlaneRequest) {
      return handleUserRequest(request, env, url, ctx);
    }
    const project = env.PROJECT_WORKSPACE.get(env.PROJECT_WORKSPACE.idFromName(route.projectId));
    try {
      if (request.method === 'GET' && route.operation === 'state') {
        return Response.json(await project.getWorkspaceState());
      }
      if (request.method === 'POST' && route.operation === 'seed/begin') {
        return Response.json(await project.beginSeed(record(await readJson(request)).seedId));
      }
      if (request.method === 'POST' && route.operation === 'seed/append') {
        const body = record(await readJson(request));
        return Response.json(await project.appendSeed(body.seedId, body.entries));
      }
      if (request.method === 'POST' && route.operation === 'seed/commit') {
        const body = record(await readJson(request));
        return Response.json(await project.commitSeed(body.seedId, body.expected));
      }
      if (request.method === 'POST' && route.operation === 'seed/abort') {
        return Response.json(await project.abortSeed(record(await readJson(request)).seedId));
      }
      if (request.method === 'POST' && route.operation === 'changes') {
        return Response.json(await project.applyChanges(await readJson(request)));
      }
      if (request.method === 'POST' && route.operation === 'sync') {
        return Response.json(await project.getSyncPage(await readJson(request)));
      }
      if (request.method === 'POST' && route.operation === 'read-text') {
        return Response.json(await project.readText(record(await readJson(request)).path));
      }
      if (request.method === 'POST' && route.operation === 'read-file') {
        const file = await project.readWorkspaceFile(record(await readJson(request)).path);
        return Response.json({ ...file, bytes: encodeBase64(file.bytes) });
      }
      if (request.method === 'POST' && route.operation === 'read-file-stream') {
        return new Response(await project.streamWorkspaceFile(record(await readJson(request)).path), {
          headers: { 'content-type': 'application/octet-stream' },
        });
      }
      if (request.method === 'GET' && route.operation === 'files') {
        return Response.json(await project.listWorkspaceFiles());
      }
      if (request.method === 'POST' && route.operation === 'directory') {
        return Response.json(await project.readDirectory(record(await readJson(request)).path));
      }
      if (request.method === 'POST' && route.operation === 'mkdir') {
        await project.makeDirectory(record(await readJson(request)).path);
        return new Response(null, { status: 204 });
      }
      if (request.method === 'POST' && route.operation === 'exec') {
        const result: unknown = await (project as unknown as { execute(value: unknown): Promise<unknown> }).execute(
          await readJson(request),
        );
        return Response.json(result);
      }
      if (request.method === 'POST' && route.operation === 'checkpoint') {
        return Response.json(await project.checkpoint());
      }
      if (request.method === 'POST' && route.operation === 'dependencies') {
        return Response.json(await project.installDependenciesTool(await readJson(request)));
      }
      if (request.method === 'POST' && route.operation === 'validate') {
        return Response.json(await project.validateTool());
      }
      if (request.method === 'POST' && route.operation === 'validation-status') {
        return Response.json(await project.validationStatus(record(await readJson(request)).revision));
      }
      if (request.method === 'POST' && route.operation === 'deployment-plan') {
        return Response.json(await project.deploymentPlan(record(await readJson(request)).revision));
      }
      if (request.method === 'POST' && route.operation === 'preview') {
        return Response.json(await project.createPreview(await readJson(request)));
      }
      if (request.method === 'POST' && route.operation === 'preview/stop') {
        await project.stopPreview(record(await readJson(request)).previewId);
        return new Response(null, { status: 204 });
      }
      if (request.method === 'POST' && route.operation === 'deploy') {
        return Response.json(await project.deploy(await readJson(request)));
      }
      if (request.method === 'DELETE' && route.operation === '') {
        await project.deleteProject();
        return new Response(null, { status: 204 });
      }
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message.slice(-4_000) : 'Workspace operation failed.' },
        { status: error instanceof SyntaxError ? 400 : 409 },
      );
    }
  },
};

async function handleUserRequest(
  request: Request,
  env: RuntimeEnv,
  url: URL,
  ctx: ExecutionContext,
): Promise<Response> {
  const origin = request.headers.get('origin');
  if (request.method === 'OPTIONS') {
    return origin ? withCors(new Response(null, { status: 204 }), origin) : new Response(null, { status: 400 });
  }
  const token = bearerToken(request) ?? url.searchParams.get('capability');
  const capability = token ? await verifyRuntimeCapability(env.CONTROL_PLANE_SECRET, token, { origin }) : null;
  if (!capability || capability.subject !== env.GHOSTBUILD_USER_ID) {
    return withCors(Response.json({ error: 'Unauthorized' }, { status: 401 }), origin);
  }
  let response: Response;
  const agentResponse = await routeUserRuntimeAgentRequest(request, env as unknown as Env, capability.subject);
  if (agentResponse) {
    response = agentResponse;
  } else if (request.method === 'POST' && url.pathname === '/v1/data') {
    response = await userRuntimeDataAction({
      request,
      env: env as unknown as Env,
      userId: capability.subject,
      executionCtx: ctx,
    });
  } else if (request.method === 'POST' && url.pathname === '/v1/chats/store') {
    response = await userRuntimeStoreChatAction({ request, env: env as unknown as Env, userId: capability.subject });
  } else if (request.method === 'POST' && url.pathname === '/v1/chats/messages') {
    response = await userRuntimeInitialMessagesAction({
      request,
      env: env as unknown as Env,
      userId: capability.subject,
    });
  } else if (request.method === 'POST' && url.pathname === '/v1/enhance-prompt') {
    response = await userRuntimeEnhancePromptAction({
      request,
      env: env as unknown as Env,
      userId: capability.subject,
    });
  } else {
    const deployment = /^\/v1\/deployments\/([^/]+)(?:\/(approve|execute|retry))?$/.exec(url.pathname);
    if (deployment && (request.method === 'GET' || request.method === 'POST')) {
      const operation =
        deployment[2] === 'approve' || deployment[2] === 'execute' || deployment[2] === 'retry' ? deployment[2] : 'get';
      response = await userRuntimeDeploymentAction({
        request,
        env: env as unknown as Env,
        userId: capability.subject,
        deploymentId: decodeURIComponent(deployment[1]!),
        operation,
      });
    } else {
      response = Response.json({ error: 'Not found' }, { status: 404 });
    }
  }
  return withCors(response, capability.origin);
}

async function readProjectFiles(workspace: WorkspaceClient): Promise<WorkspaceFile[]> {
  try {
    await workspace.fs.stat(PROJECT_ROOT);
  } catch (error) {
    if (isMissingPath(error)) return [];
    throw error;
  }
  const entries = (await workspace.fs.find(PROJECT_ROOT)).filter(
    (entry) =>
      entry.type === 'file' && !CHECKPOINT_EXCLUDED_ROOTS.has(relativeProjectPath(entry.path).split('/')[0] ?? ''),
  );
  if (entries.length > MAX_FILES) {
    throw new Error('The project workspace has too many files.');
  }
  const files: WorkspaceFile[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    const file = await readWorkspaceFile(workspace, entry.path);
    totalBytes += file.size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error('The project workspace exceeds its size limit.');
    }
    files.push(file);
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function readWorkspaceFile(workspace: WorkspaceClient, path: string): Promise<WorkspaceFile> {
  const stat = await workspace.fs.stat(path);
  if (!stat.isFile || stat.size > MAX_FILE_BYTES) {
    throw new Error(`Workspace file is invalid or too large: ${path}`);
  }
  const stream = await workspace.fs.readFile(path);
  const bytes = await readStream(stream, stat.size);
  return { path, bytes, size: bytes.byteLength, mode: stat.mode, sha256: await sha256Bytes(bytes) };
}

async function writeWorkspaceFile(
  workspace: WorkspaceClient,
  pathValue: unknown,
  bytes: Uint8Array,
  projectOnly = true,
  mode?: number,
): Promise<void> {
  const path = projectOnly ? requireProjectPath(pathValue) : requireAbsolutePath(pathValue);
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new Error(`Workspace file exceeds ${MAX_FILE_BYTES} bytes.`);
  }
  const slash = path.lastIndexOf('/');
  await workspace.fs.mkdir(path.slice(0, slash) || '/', { recursive: true });
  await workspace.fs.writeFile(path, bytes, mode === undefined ? undefined : { mode });
}

async function removeDerivedFiles(workspace: WorkspaceClient): Promise<void> {
  for (const path of DERIVED_PATHS) {
    await workspace.fs.rm(path, { recursive: true, force: true });
  }
}

async function runCommand(
  workspace: WorkspaceClient,
  command: string,
  options: {
    cwd: string;
    backend: 'worker-shell' | 'container-shell';
    timeoutMs: number;
    env?: Record<string, string>;
  },
) {
  const handle = await workspace.runtime.exec(command, {
    cwd: options.cwd,
    backend: options.backend,
    encoding: 'utf8',
    timeoutMs: options.timeoutMs,
    env: options.env,
  });
  try {
    return await handle.result();
  } finally {
    const id = handle.id;
    handle[Symbol.dispose]();
    await workspace.runtime.disposeExec(id, { backend: options.backend }).catch(() => undefined);
  }
}

function requireCommandSuccess(result: { exitCode: number; stdout: string; stderr: string }): void {
  if (result.exitCode !== 0) {
    throw new Error(`${result.stderr}\n${result.stdout}`.trim().slice(-4_000) || 'The Computer command failed.');
  }
}

function computerdBootstrapCommand(): string {
  const tokenUrl =
    'https://ghcr.io/token?service=ghcr.io&scope=repository:cloudflare/computer-computerd-linux-x64:pull';
  const blobUrl = `https://ghcr.io/v2/cloudflare/computer-computerd-linux-x64/blobs/${COMPUTERD_LAYER_DIGEST}`;
  return [
    'set -eu',
    `mkdir -p ${shellQuote(COMPUTERD_ROOT)}`,
    `token="$(curl -fsSL ${shellQuote(tokenUrl)} | jq -er .token)"`,
    `curl -fsSL -H "Authorization: Bearer $token" -o ${shellQuote(`${COMPUTERD_ROOT}/layer.tgz`)} ${shellQuote(blobUrl)}`,
    `echo ${shellQuote(`${COMPUTERD_LAYER_DIGEST.slice('sha256:'.length)}  ${COMPUTERD_ROOT}/layer.tgz`)} | sha256sum -c -`,
    `tar -xzf ${shellQuote(`${COMPUTERD_ROOT}/layer.tgz`)} -C ${shellQuote(COMPUTERD_ROOT)}`,
    `chmod 0755 ${shellQuote(COMPUTERD_BINARY)}`,
  ].join('\n');
}

async function waitForHttpPort(port: Fetcher): Promise<void> {
  const deadline = Date.now() + 45_000;
  let lastError = 'not ready';
  while (Date.now() < deadline) {
    try {
      const response = await port.fetch('http://container/');
      if (response.status >= 200 && response.status < 400) {
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await scheduler.wait(500);
  }
  throw new Error(`Preview did not become ready: ${lastError}`);
}

function fileSyncEntry(file: WorkspaceFile, revision: number) {
  const utf8 = canDecodeUtf8(file.bytes);
  return {
    kind: 'write' as const,
    path: file.path,
    content: utf8 ? decodeUtf8(file.bytes) : encodeBase64(file.bytes),
    encoding: utf8 ? ('utf8' as const) : ('base64' as const),
    size: file.size,
    sha256: file.sha256,
    revision,
  };
}

function requireFileInputs(value: unknown): Array<{ path: string; content: string; encoding: 'utf8' | 'base64' }> {
  if (!Array.isArray(value) || value.length > SYNC_BATCH_FILES) {
    throw new SyntaxError('Invalid workspace seed entries.');
  }
  return value.map((entryValue) => {
    const entry = record(entryValue);
    return {
      path: requireProjectPath(entry.path),
      content:
        typeof entry.content === 'string' ? entry.content : requireString(entry.content, 'content', MAX_FILE_BYTES),
      encoding: entry.encoding === 'base64' ? 'base64' : 'utf8',
    };
  });
}

function requireChanges(
  value: unknown,
): Array<
  | { kind: 'delete'; path: string }
  | { kind: 'write'; path: string; content: string; encoding: 'utf8' | 'base64'; mode?: number }
> {
  if (!Array.isArray(value) || value.length > SYNC_BATCH_FILES) {
    throw new SyntaxError('Invalid workspace changes.');
  }
  return value.map((changeValue) => {
    const change = record(changeValue);
    const path = requireProjectPath(change.path);
    if (change.kind === 'delete') {
      return { kind: 'delete' as const, path };
    }
    if (change.kind !== 'write' || typeof change.content !== 'string') {
      throw new SyntaxError('Invalid workspace change.');
    }
    return {
      kind: 'write' as const,
      path,
      content: change.content,
      encoding: change.encoding === 'base64' ? 'base64' : 'utf8',
      ...(change.mode === undefined ? {} : { mode: requireInteger(change.mode, 'mode', 0o7777) }),
    };
  });
}

function requireProjectPath(value: unknown, allowRoot = false): string {
  const path = requireAbsolutePath(value);
  if ((allowRoot && path === PROJECT_ROOT) || path.startsWith(`${PROJECT_ROOT}/`)) {
    return path;
  }
  throw new SyntaxError(`Path must be under ${PROJECT_ROOT}.`);
}

function requireAbsolutePath(value: unknown): string {
  const path = requireString(value, 'path', 1_024)
    .replaceAll('\\', '/')
    .replace(/\/{2,}/g, '/');
  if (!path.startsWith('/') || path.split('/').includes('..') || path.includes('\0')) {
    throw new SyntaxError('Invalid absolute workspace path.');
  }
  return path.length > 1 ? path.replace(/\/$/, '') : path;
}

function requireBackend(value: unknown): 'worker-shell' | 'container-shell' {
  if (value === undefined || value === 'worker-shell') {
    return 'worker-shell';
  }
  if (value === 'container-shell') {
    return value;
  }
  throw new SyntaxError('Invalid Computer execution backend.');
}

function decodeFileContent(content: string, encoding: 'utf8' | 'base64'): Uint8Array {
  return encoding === 'base64' ? decodeBase64(content) : new TextEncoder().encode(content);
}

function totalFileBytes(files: WorkspaceFile[]): number {
  return files.reduce((total, file) => total + file.size, 0);
}

function relativeProjectPath(path: string): string {
  return path.slice(PROJECT_ROOT.length).replace(/^\/+/, '');
}

function encodeSyncCursor(cursor: { revision: number; index: number }): string {
  return btoa(JSON.stringify(cursor));
}

function decodeSyncCursor(value: string): { revision: number; index: number } {
  try {
    const cursor = record(JSON.parse(atob(value)));
    return {
      revision: requireInteger(cursor.revision, 'cursor revision', Number.MAX_SAFE_INTEGER),
      index: requireInteger(cursor.index, 'cursor index', MAX_FILES),
    };
  } catch {
    throw new SyntaxError('Invalid workspace sync cursor.');
  }
}

async function readStream(stream: ReadableStream<Uint8Array>, expectedBytes: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const result = new Uint8Array(expectedBytes);
  let offset = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (offset + value.byteLength > result.byteLength) {
      throw new Error('Workspace file changed while it was read.');
    }
    result.set(value, offset);
    offset += value.byteLength;
  }
  if (offset !== expectedBytes) {
    throw new Error('Workspace file changed while it was read.');
  }
  return result;
}

function canDecodeUtf8(bytes: Uint8Array): boolean {
  try {
    decodeUtf8(bytes);
    return !bytes.includes(0);
  } catch {
    return false;
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get('authorization');
  return authorization?.startsWith('Bearer ') ? authorization.slice(7) : null;
}

function withCors(response: Response, origin: string | null): Response {
  if (!origin || (response as Response & { webSocket?: WebSocket }).webSocket) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.append('Vary', 'Origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function parseProjectRoute(pathname: string): { projectId: string; operation: string } | null {
  const match = /^\/v1\/projects\/([^/]+)(?:\/(.*))?$/.exec(pathname);
  if (!match) return null;
  let projectId: string;
  try {
    projectId = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  return PROJECT_ID_PATTERN.test(projectId) ? { projectId, operation: match[2] ?? '' } : null;
}

async function readJson(request: Request): Promise<unknown> {
  const length = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(length) && length > MAX_REQUEST_BYTES) {
    throw new SyntaxError('Workspace request is too large.');
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) {
    throw new SyntaxError('Workspace request is too large.');
  }
  return JSON.parse(text);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SyntaxError('Workspace request must be an object.');
  }
  return value as Record<string, unknown>;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function requireString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new SyntaxError(`Invalid ${name}.`);
  }
  return value;
}

function requireStringArray(value: unknown, name: string, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxLength || value.some((item) => typeof item !== 'string')) {
    throw new SyntaxError(`Invalid ${name}.`);
  }
  return value as string[];
}

function requireInteger(value: unknown, name: string, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new SyntaxError(`Invalid ${name}.`);
  }
  return value;
}

function requireCloudflareName(value: unknown, name: string): string {
  const result = requireString(value, name, 64);
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(result)) {
    throw new SyntaxError(`Invalid ${name}.`);
  }
  return result;
}

function parseWranglerVersion(content: string, workerName: string): string {
  if (new TextEncoder().encode(content).byteLength > 32 * 1024) {
    throw new Error('Wrangler structured output exceeds the size limit.');
  }
  const versions: string[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as Record<string, unknown>;
    if (
      entry.type === 'deploy' &&
      entry.version === 1 &&
      entry.worker_name === workerName &&
      typeof entry.version_id === 'string'
    ) {
      versions.push(entry.version_id);
    }
  }
  if (versions.length !== 1 || !/^[0-9a-f-]{32,64}$/i.test(versions[0]!)) {
    throw new Error('Wrangler did not identify exactly one published Worker version.');
  }
  return versions[0]!;
}

function requireSandboxExecSuccess(result: { success: boolean; stdout: string; stderr: string }): void {
  if (!result.success) {
    throw new Error(`${result.stderr}\n${result.stdout}`.trim() || 'The Sandbox bootstrap command failed.');
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function sha256Bytes(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(value).buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function sha256Text(value: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(value));
}

function first<T>(rows: Iterable<T>): T | undefined {
  for (const row of rows) return row;
  return undefined;
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    ((error as { code?: unknown }).code === 'ENOENT' ||
      (typeof (error as { message?: unknown }).message === 'string' &&
        /ENOENT|no such path/i.test((error as { message: string }).message)))
  );
}

function authorized(request: Request, expected: string): boolean {
  const value = request.headers.get('authorization');
  if (!value?.startsWith('Bearer ') || expected.length < 32) return false;
  const supplied = value.slice('Bearer '.length);
  if (supplied.length !== expected.length) return false;
  let mismatch = 0;
  for (let index = 0; index < supplied.length; index += 1) {
    mismatch |= supplied.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return mismatch === 0;
}

export { BuilderAgent };
