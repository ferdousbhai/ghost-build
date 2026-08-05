import {
  type DurableObjectStorageLike,
  getWorkspace,
  type SyncRetryScheduler,
  type WorkspaceClient,
  type WorkspaceOptions,
  type WorkspaceRuntimeResult,
  Workspace,
  WorkspaceProxy,
} from '@cloudflare/computer';
import {
  CloudflareContainerBackend,
  type IWorkspaceContainerAPI,
  type WorkspaceRef,
} from '@cloudflare/computer/backends/container';
import { Sandbox } from '@cloudflare/sandbox';
import { parse } from 'jsonc-parser';
import { BuilderAgent } from '../../app/agents/builder-agent';
import { routeUserRuntimeAgentRequest } from '../../app/lib/.server/agent-request-identity';
import { createTrustedDeploymentConfig } from '../../app/lib/.server/cloudflare/deployment-config';
import {
  type UserWorkspaceReadinessCheck,
  type UserWorkspaceReadinessComponent,
} from '../../app/lib/.server/cloudflare/user-workspace-runtime-health';
import { DEPLOYMENT_PROJECT_ROOT } from '../../app/lib/.server/cloudflare/deployment-runtime-policy';
import {
  MAX_DEPLOYMENT_ARTIFACT_BYTES,
  MAX_DEPLOYMENT_ARTIFACT_FILES,
  type DeploymentArtifactFile,
  type PreparedDeploymentArtifact,
  validatePreparedDeploymentArtifact,
} from '../../app/lib/.server/cloudflare/deployment-artifact';
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
import { isComputerContainerCallback } from './container-fetch-routing';
import { COMPUTERD_BINARY, computerdBootstrapCommand, containerToolchainBootstrapCommand } from './container-toolchain';
import { routeUserWorkspaceRuntimeControlPlaneRequest } from './readiness-route';
import { scheduleUserWorkspaceRuntimeMaintenance } from './scheduled-maintenance';
import { ToolOperationJournal, type ToolOperationStartResult } from './tool-operation-journal';
import { createCommittedMutationReceipt } from './mutation-receipt';
import {
  assertPreviewSourceCheckpoint,
  assertPreviewPublicationAllowed,
  PREVIEW_SNAPSHOT_ROOT,
  PREVIEW_TTL_MS,
  previewPort,
} from './preview-lifecycle';
import {
  WorkspaceOperationConflictError,
  WorkspaceOperationIndeterminateError,
  WorkspaceOperationLane,
  type WorkspaceOperationLease,
} from './workspace-operation-lane';
import {
  DurableWorkspaceSyncRetryScheduler,
  requireDurableCommandResult,
  requireWorkspaceSyncBarrier,
  WorkspaceSyncPendingError,
} from './workspace-sync-retry';
import { stableWorkspaceRead } from './stable-workspace-read';
import { requireDeploymentMigrationName, requireWorkspaceFileEncoding } from './workspace-input';
import { withCors } from './http-cors';
import {
  createContainerDirectoryCommand,
  createIsolatedProjectCommand,
  ISOLATED_PROJECT_ROOT,
  rebaseDeploymentConfigPaths,
  relativeIsolatedPath,
} from './isolated-project';

export { WorkspaceProxy };

interface RuntimeEnv {
  PROJECT_WORKSPACE: DurableObjectNamespace<ProjectWorkspace>;
  BuilderAgent: DurableObjectNamespace<BuilderAgent>;
  DB: D1Database;
  AI: Ai;
  CONTROL_PLANE_SECRET: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  GHOSTBUILD_USER_ID: string;
  GHOSTBUILD_CONNECTION_ID: string;
  GHOSTBUILD_CONNECTION_GENERATION: string;
  GHOSTBUILD_USER_RUNTIME: string;
  GHOSTBUILD_USER_RUNTIME_ENDPOINT: string;
  GHOSTBUILD_CONTROL_PLANE_ENDPOINT: string;
  GHOSTBUILD_RUNTIME_VERSION: string;
  SANDBOX_TRANSPORT: 'rpc';
}

const PROJECT_ROOT = DEPLOYMENT_PROJECT_ROOT;
const READINESS_ROOT = '/home/.ghostbuild-readiness';
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 10_000;
const SYNC_BATCH_BYTES = 4 * 1024 * 1024;
const SYNC_BATCH_FILES = 100;
const CHECKPOINT_EXCLUDED_ROOTS = new Set(['node_modules', 'dist', '.output', '.tanstack', '.wrangler']);
const INSTALL_COMMAND =
  'pnpm install --frozen-lockfile --ignore-scripts=true --ignore-pnpmfile --registry=https://registry.npmjs.org/';
const COMPUTERD_PROCESS_ID = 'ghostbuild-computerd';
const OPERATION_LEASE_MS = {
  seed: 10 * 60_000,
  write: 10 * 60_000,
  exec: 10 * 60_000,
  install: 15 * 60_000,
  validate: 30 * 60_000,
  preview: 30 * 60_000,
  deployment: 45 * 60_000,
  delete: 15 * 60_000,
} as const;

type StatefulOperationKind = keyof typeof OPERATION_LEASE_MS;

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

type ActivePreviewRow = {
  preview_id: string;
  exec_id: string;
  port: number;
  snapshot_root: string;
  snapshot_revision: string;
  workspace_revision: number;
};

type PreviewResultRow = {
  preview_id: string;
  url: string;
  snapshot_revision: string;
  workspace_revision: number;
  ready_at: number;
  expires_at: number;
};

type DeploymentSessionRow = {
  operation_id: string;
  owner: string;
  idempotency_key: string;
  expected_workspace_revision: number;
  expected_snapshot_revision: string;
  acquired_at: number;
  deadline: number;
  status: 'active' | 'completed' | 'failed' | 'indeterminate';
};

class ComputerSandboxBase extends Sandbox<RuntimeEnv> {
  readonly containerBackend = new CloudflareContainerBackend({
    container: () => this,
    workspace: { binding: 'PROJECT_WORKSPACE', id: this.ctx.id.toString() },
    containerEnv: { MOUNT_POINT: '/home', FUSE_MOUNT: 'auto' },
    connectTimeoutMs: 2 * 60_000,
    id: 'container-shell',
  });

  readonly #computerHost = new SandboxComputerHost(this);

  getWorkspaceContainer(): IWorkspaceContainerAPI {
    return this.#computerHost;
  }

  async startComputerd(env: Record<string, string>): Promise<void> {
    requireSandboxExecSuccess(await this.exec(containerToolchainBootstrapCommand(), { timeout: 2 * 60_000 }));
    const existing = await this.getProcess(COMPUTERD_PROCESS_ID).catch(() => null);
    if (existing && (existing.status === 'starting' || existing.status === 'running')) {
      return;
    }
    await this.cleanupCompletedProcesses().catch(() => undefined);
    requireSandboxExecSuccess(await this.exec(computerdBootstrapCommand(), { timeout: 5 * 60_000 }));
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

function computerWorkspaceOptions(
  self: InstanceType<typeof ComputerSandboxBase>,
  retryScheduler: SyncRetryScheduler,
): WorkspaceOptions {
  const { ctx } = self as unknown as { ctx: DurableObjectState };
  return {
    storage: ctx.storage as unknown as DurableObjectStorageLike,
    backends: [self.containerBackend],
    waitUntil: (promise) => ctx.waitUntil(promise),
    retryScheduler,
    retry: { initialDelayMs: 1_000, maxDelayMs: 60_000, maxAttempts: 5 },
  };
}

export class ProjectWorkspace extends ComputerSandboxBase {
  readonly #workspace: Workspace;
  readonly #toolOperations: ToolOperationJournal;
  readonly #operationLane: WorkspaceOperationLane;
  readonly #syncRetries: DurableWorkspaceSyncRetryScheduler;
  readonly #activeOperationOwners = new Set<string>();
  readonly #activeSyncRecoveries = new Map<string, Promise<boolean>>();
  #containerKeepAliveOperations = 0;

  constructor(ctx: DurableObjectState<{}>, env: RuntimeEnv) {
    super(ctx, env);
    this.#syncRetries = new DurableWorkspaceSyncRetryScheduler(ctx.storage, async (intent) => {
      const schedule = this.schedule as unknown as (
        when: number,
        callback: string,
        payload: unknown,
        options: { idempotent: true },
      ) => Promise<unknown>;
      await schedule.call(
        this,
        Math.max(0, Math.ceil((intent.notBefore - Date.now()) / 1_000)),
        'retryPendingComputerSync',
        { backend: intent.backend, attempt: intent.attempt, notBefore: intent.notBefore },
        { idempotent: true },
      );
    });
    this.#syncRetries.initialize();
    this.ctx.waitUntil(
      this.#syncRetries
        .reconcile()
        .catch((error) => console.error('Unable to reconcile persisted Computer sync retries', error)),
    );
    this.#workspace = new Workspace(computerWorkspaceOptions(this, this.#syncRetries));
    this.#toolOperations = new ToolOperationJournal(ctx.storage);
    this.#toolOperations.initialize();
    if (this.#toolOperations.pending().length > 0 || this.#syncRetries.state('container-shell')?.exhausted === true) {
      this.ctx.waitUntil(this.reconcilePendingCommands());
    }
    this.#operationLane = new WorkspaceOperationLane(
      ctx.storage,
      (owner) => this.#activeOperationOwners.has(owner),
      (kind) => kind === 'validate',
    );
    this.#operationLane.initialize();
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ghostbuild_workspace_state (
         singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
         initialized INTEGER NOT NULL DEFAULT 0,
         seed_id TEXT,
         reset_revision INTEGER NOT NULL DEFAULT 0
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
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ghostbuild_workspace_identity (
         singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
         project_id TEXT NOT NULL,
         user_id TEXT NOT NULL,
         initialized_at INTEGER NOT NULL
       )`,
    );
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ghostbuild_active_preview (
         singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
         preview_id TEXT NOT NULL UNIQUE,
         exec_id TEXT NOT NULL,
         port INTEGER NOT NULL,
         snapshot_root TEXT NOT NULL,
         snapshot_revision TEXT NOT NULL,
         workspace_revision INTEGER NOT NULL,
         activated_at INTEGER NOT NULL
       )`,
    );
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ghostbuild_deployment_sessions (
         operation_id TEXT PRIMARY KEY,
         owner TEXT NOT NULL,
         idempotency_key TEXT NOT NULL UNIQUE,
         expected_workspace_revision INTEGER NOT NULL,
         expected_snapshot_revision TEXT NOT NULL,
         acquired_at INTEGER NOT NULL,
         deadline INTEGER NOT NULL,
         status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'failed', 'indeterminate')),
         updated_at INTEGER NOT NULL
       )`,
    );
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ghostbuild_preview_cancellations (
         preview_id TEXT PRIMARY KEY,
         cancelled_at INTEGER NOT NULL
       )`,
    );
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ghostbuild_preview_results (
         preview_id TEXT PRIMARY KEY,
         url TEXT NOT NULL,
         snapshot_revision TEXT NOT NULL,
         workspace_revision INTEGER NOT NULL,
         ready_at INTEGER NOT NULL,
         expires_at INTEGER NOT NULL
       )`,
    );
  }

  override fetch(request: Request): Promise<Response> {
    if (isComputerContainerCallback(request)) {
      return this.containerBackend.handleFetch(request);
    }
    return super.fetch(request);
  }

  async __getWorkspaceStub() {
    await this.#workspace.ready();
    return this.#workspace.stub();
  }

  initializeProjectIdentity(value: unknown): void {
    const input = record(value);
    const projectId = requireString(input.projectId, 'projectId', 256);
    const userId = requireString(input.userId, 'userId', 256);
    if (userId !== this.env.GHOSTBUILD_USER_ID) {
      throw new Error('ProjectWorkspace user isolation check failed.');
    }
    this.ctx.storage.transactionSync(() => {
      const existing = first(
        this.ctx.storage.sql.exec<{ project_id: string; user_id: string }>(
          `SELECT project_id, user_id FROM ghostbuild_workspace_identity WHERE singleton = 1`,
        ),
      );
      if (existing && (existing.project_id !== projectId || existing.user_id !== userId)) {
        throw new Error('ProjectWorkspace identity does not match its durable owner.');
      }
      if (!existing) {
        this.ctx.storage.sql.exec(
          `INSERT INTO ghostbuild_workspace_identity (singleton, project_id, user_id, initialized_at)
           VALUES (1, ?, ?, ?)`,
          projectId,
          userId,
          Date.now(),
        );
      }
    });
  }

  async retryPendingComputerSync(value: unknown): Promise<void> {
    const backend = requireBackend(record(value).backend);
    const state = this.#syncRetries.state(backend);
    if (!state) {
      return;
    }
    if (state.exhausted) {
      const recovered = await this.recoverExhaustedComputerSync(backend);
      if (!recovered) {
        await this.schedulePendingCommandRecovery(60_000);
      }
      console.info('ProjectWorkspace Computer sync retry is exhausted', {
        backend,
        attempt: state.attempt,
        ageMs: Math.max(0, Date.now() - state.createdAt),
        exhaustion: true,
        recovery: recovered ? 'complete' : 'pending',
      });
      return;
    }
    const now = Date.now();
    if (state.notBefore > now) {
      await this.#syncRetries.schedule({ backend, attempt: state.attempt, notBefore: state.notBefore });
      return;
    }
    const result = await this.#workspace.retryPendingSync(backend);
    const event = {
      backend,
      attempt: state.attempt,
      ageMs: Math.max(0, now - state.createdAt),
      cause: state.lastError ? 'post_command_pull_failed' : 'post_command_pull_pending',
      completion: result.status,
      exhaustion: result.status === 'exhausted',
    };
    if (result.status === 'pending' || result.status === 'exhausted') {
      this.#syncRetries.recordFailure(backend, result.error, result.status === 'exhausted');
    }
    if (result.status === 'complete' || result.status === 'idle') {
      this.finishPendingCommand(backend);
      await this.cleanupReadinessRoot().catch(() => undefined);
    } else if (result.status === 'exhausted') {
      const recovered = await this.recoverExhaustedComputerSync(backend);
      if (!recovered) {
        await this.schedulePendingCommandRecovery(60_000);
      }
    }
    console.info('ProjectWorkspace Computer sync retry', event);
  }

  /**
   * A command continuation owns its own recovery wake. Computer clears its
   * retry intent before returning a successful retry, so its scheduler row
   * cannot be the only durable evidence that the original tool still needs
   * terminalization.
   */
  async reconcilePendingCommands(): Promise<void> {
    let retryAt = Number.POSITIVE_INFINITY;
    const pending = this.#toolOperations.pending();
    const backends = new Set(pending.map((continuation) => continuation.backend));
    if (this.#syncRetries.state('container-shell')?.exhausted) {
      backends.add('container-shell');
    }
    for (const backend of backends) {
      const state = this.#syncRetries.state(backend);
      try {
        if (state) {
          if (state.exhausted) {
            if (!(await this.recoverExhaustedComputerSync(backend))) {
              retryAt = Math.min(retryAt, Date.now() + 60_000);
            }
            continue;
          }
          if (state.notBefore > Date.now()) {
            retryAt = Math.min(retryAt, state.notBefore);
            continue;
          }
          await this.retryPendingComputerSync({ backend });
          const retry = this.#syncRetries.state(backend);
          if (retry) {
            retryAt = Math.min(retryAt, retry.exhausted ? Date.now() + 60_000 : retry.notBefore);
          }
        } else {
          // Absence of Computer's retry row is not proof of success: the
          // package intentionally swallows host scheduling failures after a
          // command. An ordinary pull is idempotent and proves remote changes
          // reached the durable VFS before the tool result is exposed.
          await this.#workspace.pull(backend);
          this.finishPendingCommand(backend);
          await this.cleanupReadinessRoot().catch(() => undefined);
        }
      } catch {
        retryAt = Math.min(retryAt, Date.now() + 1_000);
      }
    }
    if (this.#toolOperations.pending().length > 0 || this.#syncRetries.state('container-shell')?.exhausted === true) {
      await this.schedulePendingCommandRecovery(Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : 1_000);
    }
  }

  async beginToolOperation(value: unknown): Promise<ToolOperationStartResult> {
    this.requireCompletedComputerSync();
    const input = record(value);
    const toolCallId = requireString(input.toolCallId, 'toolCallId', 512);
    const toolName = requireRemoteToolName(input.toolName);
    const argsJson = requireString(input.argsJson, 'argsJson', MAX_REQUEST_BYTES);
    return this.#toolOperations.begin({
      toolCallId,
      toolName,
      argsSha256: await sha256Text(argsJson),
    });
  }

  completeToolOperation(value: unknown): unknown {
    const input = record(value);
    const toolCallId = requireString(input.toolCallId, 'toolCallId', 512);
    const toolName = this.#toolOperations.toolName(toolCallId);
    if (toolName === 'write' || toolName === 'edit') {
      const receipt = this.#toolOperations.mutationReceipt(toolCallId);
      if (receipt) {
        return this.#toolOperations.acknowledgeMutation({ toolCallId, result: input.result });
      }
    }
    return this.#toolOperations.complete({
      toolCallId,
      result: input.result,
    });
  }

  failToolOperation(value: unknown): void {
    const input = record(value);
    this.#toolOperations.fail({
      toolCallId: requireString(input.toolCallId, 'toolCallId', 512),
      error: requireString(input.error, 'error', 4_000),
    });
  }

  async getWorkspaceState(): Promise<WorkspaceState> {
    const snapshot = await this.stableProjectRead(readProjectFiles);
    return this.stateFromFiles(snapshot.value, snapshot.revision);
  }

  async runReadinessProbe() {
    const components = {} as Partial<Record<UserWorkspaceReadinessComponent, UserWorkspaceReadinessCheck>>;
    const nonce = crypto.randomUUID();
    const path = `${READINESS_ROOT}/${nonce}.txt`;
    let blocked = false;
    let syncPending = false;
    const check = async (
      name: UserWorkspaceReadinessComponent,
      operation: () => Promise<void>,
      successCode: string,
    ): Promise<boolean> => {
      if (blocked) {
        components[name] = { ok: false, code: 'blocked_by_dependency', durationMs: 0 };
        return false;
      }
      const startedAt = Date.now();
      try {
        await operation();
        components[name] = { ok: true, code: successCode, durationMs: Date.now() - startedAt };
        return true;
      } catch (error) {
        const pendingError = error instanceof WorkspaceSyncPendingError ? error : null;
        syncPending = pendingError !== null;
        components[name] = {
          ok: false,
          code: pendingError?.code ?? 'unavailable',
          durationMs: Date.now() - startedAt,
        };
        blocked = true;
        return false;
      }
    };

    await check(
      'durableVfs',
      () =>
        this.withComputer(async (workspace) => {
          await workspace.fs.rm(READINESS_ROOT, { recursive: true, force: true });
          await writeWorkspaceFile(workspace, path, new TextEncoder().encode(nonce), false);
          if (decodeUtf8((await readWorkspaceFile(workspace, path)).bytes) !== nonce) {
            throw new Error('Durable VFS sentinel mismatch.');
          }
        }),
      'read_write_ready',
    );
    const containerNonce = `${nonce}-container`;
    await check(
      'container',
      () =>
        this.withComputer(async (workspace) => {
          requireCommandSuccess(
            await runCommand(workspace, `printf %s ${shellQuote(containerNonce)} > ${shellQuote(path)}`, {
              cwd: '/home',
              backend: 'container-shell',
              timeoutMs: 7 * 60_000,
            }),
          );
        }),
      'computerd_ready',
    );
    await check(
      'fuse',
      async () => {
        const snapshot = await this.stableProjectRead((workspace) => readWorkspaceFile(workspace, path));
        if (decodeUtf8(snapshot.value.bytes) !== containerNonce) {
          throw new Error('FUSE sentinel mismatch.');
        }
      },
      'container_write_visible',
    );
    components.sync = blocked
      ? {
          ok: false,
          code: syncPending ? 'workspace_sync_pending' : 'dependency_failed',
          durationMs: 0,
        }
      : { ok: true, code: 'completed', durationMs: 0 };

    const cleanupStartedAt = Date.now();
    if (syncPending) {
      components.cleanup = { ok: false, code: 'deferred_until_sync_retry', durationMs: 0 };
    } else {
      try {
        await this.cleanupReadinessRoot();
        components.cleanup = { ok: true, code: 'removed', durationMs: Date.now() - cleanupStartedAt };
      } catch {
        components.cleanup = { ok: false, code: 'cleanup_failed', durationMs: Date.now() - cleanupStartedAt };
      }
    }
    return {
      ok: ['durableVfs', 'container', 'fuse', 'sync', 'cleanup'].every(
        (name) => components[name as UserWorkspaceReadinessComponent]?.ok === true,
      ),
      components,
    };
  }

  async getWorkspaceSnapshot() {
    const snapshot = await this.stableProjectRead(readProjectFiles);
    return {
      state: this.stateFromFiles(snapshot.value, snapshot.revision),
      files: snapshot.value.map((file) => workspaceFileMetadata(file, snapshot.revision)),
    };
  }

  async beginSeed(seedIdValue: unknown) {
    const seedId = requireString(seedIdValue, 'seedId', 256);
    return this.withStatefulOperation('seed', `seed:begin:${seedId}`, async () => {
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
    });
  }

  async appendSeed(seedIdValue: unknown, entriesValue: unknown) {
    const seedId = requireString(seedIdValue, 'seedId', 256);
    const entries = requireFileInputs(entriesValue);
    const key = `seed:append:${seedId}:${await sha256Text(JSON.stringify(entries))}`;
    return this.withStatefulOperation('seed', key, async () => {
      if (this.workspaceRow().seed_id !== seedId) {
        throw new Error('The workspace seed is no longer active.');
      }
      await this.withComputer(async (workspace) => {
        for (const entry of entries) {
          await writeWorkspaceFile(workspace, entry.path, decodeFileContent(entry.content, entry.encoding));
        }
      });
      return this.getWorkspaceState();
    });
  }

  async commitSeed(seedIdValue: unknown, expectedValue: unknown) {
    const seedId = requireString(seedIdValue, 'seedId', 256);
    const expected = record(expectedValue);
    const expectedFiles = requireInteger(expected.fileCount, 'fileCount', MAX_FILES);
    const expectedBytes = requireInteger(expected.totalBytes, 'totalBytes', MAX_TOTAL_BYTES);
    return this.withStatefulOperation('seed', `seed:commit:${seedId}:${expectedFiles}:${expectedBytes}`, async () => {
      if (this.workspaceRow().seed_id !== seedId) {
        throw new Error('The workspace seed is no longer active.');
      }
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
    });
  }

  async abortSeed(seedIdValue: unknown) {
    const seedId = requireString(seedIdValue, 'seedId', 256);
    return this.withStatefulOperation('seed', `seed:abort:${seedId}`, async () => {
      if (this.workspaceRow().seed_id === seedId) {
        await this.withComputer((workspace) => workspace.fs.rm(PROJECT_ROOT, { recursive: true, force: true }));
        this.ctx.storage.sql.exec(
          `UPDATE ghostbuild_workspace_state SET initialized = 0, seed_id = NULL, reset_revision = ? WHERE singleton = 1`,
          this.currentRevision(),
        );
      }
      return this.getWorkspaceState();
    });
  }

  async applyChanges(value: unknown) {
    const input = record(value);
    const baseRevision = requireInteger(input.baseRevision, 'baseRevision', Number.MAX_SAFE_INTEGER);
    const changes = requireChanges(input.changes);
    const operationKey =
      typeof input.operationKey === 'string'
        ? requireString(input.operationKey, 'operationKey', 512)
        : `change:${baseRevision}:${await sha256Text(JSON.stringify(changes))}`;
    return this.withStatefulOperation('write', operationKey, async () => {
      if (this.workspaceRow().seed_id !== null) {
        throw new WorkspaceOperationConflictError('seed', 1_000);
      }
      if (baseRevision !== this.currentRevision()) {
        return { ok: false as const, conflict: true as const, state: await this.getWorkspaceState() };
      }
      const existingFiles = await this.withComputer(readProjectFiles);
      if (baseRevision !== this.currentRevision()) {
        return { ok: false as const, conflict: true as const, state: await this.getWorkspaceState() };
      }
      const projectedFiles = new Map(existingFiles.map((file) => [file.path, { size: file.size, mode: file.mode }]));
      const decodedWrites = new Map<string, { bytes: Uint8Array; mode?: number; sha256: string }>();
      for (const change of changes) {
        if (change.kind === 'delete') {
          for (const path of projectedFiles.keys()) {
            if (path === change.path || path.startsWith(`${change.path}/`)) {
              projectedFiles.delete(path);
            }
          }
          continue;
        }
        const bytes = decodeFileContent(change.content, change.encoding);
        if (bytes.byteLength > MAX_FILE_BYTES) {
          throw new Error(`Workspace file exceeds ${MAX_FILE_BYTES} bytes.`);
        }
        const mode = change.mode ?? projectedFiles.get(change.path)?.mode;
        decodedWrites.set(change.path, { bytes, mode, sha256: await sha256Bytes(bytes) });
        projectedFiles.set(change.path, { size: bytes.byteLength, mode: mode ?? 0o644 });
      }
      if (
        projectedFiles.size > MAX_FILES ||
        [...projectedFiles.values()].reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL_BYTES
      ) {
        throw new Error('The project workspace exceeds its size limit.');
      }
      const changedPaths = await this.withComputer(async (workspace) => {
        for (const change of changes) {
          if (change.kind === 'delete') {
            await workspace.fs.rm(change.path, { recursive: true, force: true });
            continue;
          }
          const write = decodedWrites.get(change.path)!;
          await writeWorkspaceFile(workspace, change.path, write.bytes, true, write.mode);
        }
        return changes.map((change) => change.path);
      });
      const committedRevision = this.currentRevision();
      if (typeof input.toolCallId === 'string') {
        const toolCallId = requireString(input.toolCallId, 'toolCallId', 512);
        const toolName = this.#toolOperations.toolName(toolCallId);
        if (toolName === 'write' || toolName === 'edit') {
          this.#toolOperations.commitMutation({
            toolCallId,
            receipt: createCommittedMutationReceipt({
              tool: toolName,
              files: changes.map((change) => {
                const write = change.kind === 'write' ? decodedWrites.get(change.path)! : null;
                return {
                  path: change.path,
                  revision: committedRevision,
                  size: write?.bytes.byteLength ?? 0,
                  sha256: write?.sha256 ?? null,
                  deleted: change.kind === 'delete',
                  ...(write
                    ? {
                        changedRange: {
                          startLine: 1,
                          endLine: canDecodeUtf8(write.bytes) ? decodeUtf8(write.bytes).split('\n').length : 1,
                        },
                      }
                    : {}),
                };
              }),
            }),
          });
        }
      }
      const state = await this.getWorkspaceState();
      return { ok: true as const, state, changedPaths };
    });
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
    const snapshot = await this.stableProjectRead((workspace) => readWorkspaceFile(workspace, path));
    const file = snapshot.value;
    const content = decodeUtf8(file.bytes);
    return {
      path,
      content,
      encoding: 'utf8' as const,
      size: file.size,
      sha256: file.sha256,
      revision: snapshot.revision,
    };
  }

  async readWorkspaceFile(pathValue: unknown) {
    const path = requireProjectPath(pathValue);
    const snapshot = await this.stableProjectRead((workspace) => readWorkspaceFile(workspace, path));
    const file = snapshot.value;
    return {
      path,
      bytes: file.bytes,
      encoding: canDecodeUtf8(file.bytes) ? ('utf8' as const) : ('base64' as const),
      size: file.size,
      mode: file.mode,
      sha256: file.sha256,
      revision: snapshot.revision,
    };
  }

  async streamWorkspaceFile(pathValue: unknown): Promise<ReadableStream<Uint8Array>> {
    const path = requireProjectPath(pathValue);
    const snapshot = await this.stableProjectRead((workspace) => readWorkspaceFile(workspace, path));
    return new Blob([new Uint8Array(snapshot.value.bytes)]).stream();
  }

  async listWorkspaceFiles() {
    const snapshot = await this.stableProjectRead(readProjectFiles);
    return snapshot.value.map((file) => workspaceFileMetadata(file, snapshot.revision));
  }

  async readDirectory(pathValue: unknown) {
    const path = requireProjectPath(pathValue, true);
    const snapshot = await this.stableProjectRead((workspace) => workspace.fs.readdir(path));
    return snapshot.value.map((entry) => ({
      name: entry.name,
      isFile: entry.isFile,
      isDirectory: entry.isDirectory,
    }));
  }

  async makeDirectory(pathValue: unknown) {
    const path = requireProjectPath(pathValue, true);
    await this.withStatefulOperation('write', `mkdir:${path}`, () =>
      this.withComputer((workspace) => workspace.fs.mkdir(path, { recursive: true })),
    );
  }

  async execute(value: unknown): Promise<WorkspaceRuntimeResult<'utf8'>> {
    const input = record(value);
    const command = requireString(input.command, 'command', 64 * 1024);
    const cwd = input.cwd === undefined ? PROJECT_ROOT : requireProjectPath(input.cwd, true);
    const backend = requireBackend(input.backend);
    const operationKey =
      typeof input.operationKey === 'string'
        ? requireString(input.operationKey, 'operationKey', 512)
        : `exec:${await sha256Text(JSON.stringify([command, cwd, backend]))}`;
    const toolCallId = operationKey.startsWith('tool:') ? operationKey.slice('tool:'.length) : null;
    return this.withStatefulOperation('exec', operationKey, () =>
      this.withComputer((workspace) =>
        runCommand(workspace, command, {
          cwd,
          backend,
          timeoutMs: 5 * 60_000,
          ...(toolCallId
            ? {
                onSyncPending: (result: WorkspaceRuntimeResult<'utf8'>) => {
                  this.registerPendingCommand({
                    backend,
                    toolCallId,
                    result: {
                      command,
                      cwd,
                      backend,
                      exitCode: result.exitCode,
                      stdout: result.stdout,
                      stderr: result.stderr,
                    },
                  });
                },
              }
            : {}),
        }),
      ),
    );
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
    const toolCallId = requireString(input.toolCallId, 'toolCallId', 512);
    const mode = input.mode === 'sync-lockfile' ? 'sync-lockfile' : input.mode === 'add' ? 'add' : null;
    const packages = requireStringArray(input.packages, 'packages', 100);
    if (!mode) {
      throw new SyntaxError('Invalid dependency installation mode.');
    }
    return this.runToolOperation(toolCallId, 'npmInstall', { input: input.input, mode, packages }, () =>
      this.withStatefulOperation('install', `tool:${toolCallId}`, async () => {
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
      }),
    );
  }

  async validateTool(value: unknown): Promise<GhostbuildToolResult> {
    const input = record(value);
    const toolCallId = requireString(input.toolCallId, 'toolCallId', 512);
    return this.runToolOperation(toolCallId, 'validateProject', input.input, () =>
      this.withStatefulOperation('validate', `tool:${toolCallId}`, async () => {
        const before = await this.checkpoint();
        const startedAt = Date.now();
        const isolatedRoot = `${ISOLATED_PROJECT_ROOT}/validation-${crypto.randomUUID()}`;
        try {
          try {
            await this.withComputer(async (workspace) => {
              requireCommandSuccess(
                await runCommand(
                  workspace,
                  createIsolatedProjectCommand({ projectRoot: PROJECT_ROOT, isolatedRoot, quote: shellQuote }),
                  { cwd: PROJECT_ROOT, backend: 'container-shell', timeoutMs: 2 * 60_000 },
                ),
              );
              if ((await this.checkpoint()).revision !== before.revision) {
                throw new Error('The project changed while validation was being isolated. Validate the new revision.');
              }
              requireCommandSuccess(await runNativeCommand(workspace, isolatedRoot, INSTALL_COMMAND, 4 * 60_000));
              for (const command of [
                'pnpm run typecheck',
                'pnpm run verify:stack',
                'pnpm run build',
                'pnpm run lint',
              ]) {
                requireCommandSuccess(await runNativeCommand(workspace, isolatedRoot, command, 5 * 60_000));
              }
            });
          } finally {
            await this.withComputer((workspace) =>
              runCommand(workspace, `rm -rf ${shellQuote(isolatedRoot)}`, {
                cwd: PROJECT_ROOT,
                backend: 'container-shell',
                timeoutMs: 30_000,
              }),
            ).catch(() => undefined);
          }
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
            checks: [
              'workspace-policy',
              'dependency-installation',
              'typecheck',
              'stack-verification',
              'build',
              'lint',
            ].map((name) => ({ name, status: 'passed' as const })),
            durationMs: Date.now() - startedAt,
            nextAction: 'prepare-deployment',
          });
        } catch (error) {
          if (error instanceof WorkspaceSyncPendingError) {
            throw error;
          }
          return toolFailure(error instanceof Error ? error.message.slice(-4_000) : 'User-owned validation failed.', {
            level: 'full',
            revision: before.revision,
            workspaceRevision: before.workspaceRevision,
            currentWorkspaceRevision: this.currentRevision(),
            buildEnvironment: 'cloudflare-computer-container',
            checks: [{ name: 'production-build', status: 'failed' as const }],
          });
        }
      }),
    );
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

  async beginDeploymentSession(value: unknown) {
    this.requireCompletedComputerSync();
    const input = record(value);
    const operationId = requireString(input.operationId, 'operationId', 256);
    const expectedWorkspaceRevision = requireInteger(
      input.expectedWorkspaceRevision,
      'expectedWorkspaceRevision',
      Number.MAX_SAFE_INTEGER,
    );
    const expectedSnapshotRevision = requireSnapshotRevision(input.expectedSnapshotRevision);
    const idempotencyKey = `deployment-session:${operationId}`;
    const owner = `deployment:${operationId}`;
    const existing = this.deploymentSessionRow(operationId);
    if (existing) {
      assertDeploymentSessionIdentity(existing, expectedWorkspaceRevision, expectedSnapshotRevision);
      if (existing.status !== 'active') {
        throw new WorkspaceOperationIndeterminateError('deployment');
      }
      const lease = this.#operationLane.find(existing.idempotency_key, existing.owner);
      if (!lease || lease.deadline <= Date.now()) {
        this.ctx.storage.sql.exec(
          `UPDATE ghostbuild_deployment_sessions SET status = 'indeterminate', updated_at = ?
           WHERE operation_id = ? AND status = 'active'`,
          Date.now(),
          operationId,
        );
        throw new WorkspaceOperationIndeterminateError('deployment');
      }
      await this.assertDeploymentSession({ sessionId: operationId });
      return { sessionId: operationId };
    }

    const lease = this.#operationLane.acquire({
      owner,
      idempotencyKey,
      kind: 'deployment',
      leaseMs: OPERATION_LEASE_MS.deployment,
    });
    this.ctx.storage.sql.exec(
      `INSERT INTO ghostbuild_deployment_sessions (
         operation_id, owner, idempotency_key, expected_workspace_revision,
         expected_snapshot_revision, acquired_at, deadline, status, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      operationId,
      owner,
      idempotencyKey,
      expectedWorkspaceRevision,
      expectedSnapshotRevision,
      lease.acquiredAt,
      lease.deadline,
      lease.acquiredAt,
    );
    try {
      await this.assertDeploymentSession({ sessionId: operationId });
      return { sessionId: operationId };
    } catch (error) {
      await this.finishDeploymentSession({ sessionId: operationId, status: 'failed' }).catch(() => undefined);
      throw error;
    }
  }

  async assertDeploymentSession(value: unknown) {
    this.requireCompletedComputerSync();
    const sessionId = requireString(record(value).sessionId, 'sessionId', 256);
    const session = this.requireActiveDeploymentSession(sessionId);
    this.#activeOperationOwners.add(session.owner);
    try {
      const lease = this.deploymentSessionLease(session);
      const renewed = this.#operationLane.renew(lease, OPERATION_LEASE_MS.deployment);
      this.ctx.storage.sql.exec(
        `UPDATE ghostbuild_deployment_sessions SET deadline = ?, updated_at = ?
         WHERE operation_id = ? AND status = 'active'`,
        renewed.deadline,
        Date.now(),
        sessionId,
      );
      const checkpoint = await this.checkpoint();
      if (checkpoint.revision !== session.expected_snapshot_revision) {
        throw new Error('The project changed during its deployment session. Publication was cancelled.');
      }
      return checkpoint;
    } finally {
      this.#activeOperationOwners.delete(session.owner);
    }
  }

  async finishDeploymentSession(value: unknown) {
    const input = record(value);
    const sessionId = requireString(input.sessionId, 'sessionId', 256);
    const status = input.status === 'completed' ? 'completed' : input.status === 'failed' ? 'failed' : null;
    if (!status) {
      throw new SyntaxError('Invalid deployment session status.');
    }
    const session = this.deploymentSessionRow(sessionId);
    if (!session) {
      throw new Error('The deployment session does not exist.');
    }
    if (session.status === status) {
      const lease = this.#operationLane.find(session.idempotency_key, session.owner);
      if (lease) {
        this.#operationLane.release(lease);
      }
      this.#activeOperationOwners.delete(session.owner);
      return { status };
    }
    if (session.status !== 'active') {
      throw new WorkspaceOperationIndeterminateError('deployment');
    }
    const lease = this.#operationLane.find(session.idempotency_key, session.owner);
    if (lease) {
      this.#operationLane.release(lease);
    }
    this.ctx.storage.sql.exec(
      `UPDATE ghostbuild_deployment_sessions SET status = ?, updated_at = ?
       WHERE operation_id = ? AND status = 'active'`,
      status,
      Date.now(),
      sessionId,
    );
    this.#activeOperationOwners.delete(session.owner);
    return { status };
  }

  async createPreview(value: unknown) {
    const input = record(value);
    const previewId = requirePreviewId(input.previewId);
    const expectedWorkspaceRevision = requireInteger(
      input.expectedWorkspaceRevision,
      'expectedWorkspaceRevision',
      Number.MAX_SAFE_INTEGER,
    );
    const expectedSnapshotRevision = requireSnapshotRevision(input.expectedSnapshotRevision);
    const replay = this.previewResultRow(previewId);
    if (replay) {
      if (
        replay.snapshot_revision !== expectedSnapshotRevision ||
        replay.workspace_revision !== expectedWorkspaceRevision
      ) {
        throw new WorkspaceOperationIndeterminateError('preview');
      }
      if (replay.expires_at > Date.now()) {
        return previewSuccess(replay);
      }
      this.ctx.storage.sql.exec('DELETE FROM ghostbuild_preview_results WHERE preview_id = ?', previewId);
    }
    return this.withStatefulOperation(
      'preview',
      `preview:${previewId}:${expectedWorkspaceRevision}:${expectedSnapshotRevision}`,
      async () => {
        await this.assertPreviewCheckpoint(expectedWorkspaceRevision, expectedSnapshotRevision, true);
        this.requirePreviewNotCancelled(previewId);
        const previous = this.activePreviewRow();
        const port = previewPort(previewId, previous?.port);
        const execId = `preview-${previewId}`;
        const snapshotRoot = `${PREVIEW_SNAPSHOT_ROOT}/${previewId}`;
        const pending: ActivePreviewRow = {
          preview_id: previewId,
          exec_id: execId,
          port,
          snapshot_root: snapshotRoot,
          snapshot_revision: expectedSnapshotRevision,
          workspace_revision: expectedWorkspaceRevision,
        };
        let published = false;
        try {
          await this.withComputer(async (workspace) => {
            await cleanupPreviewProcess(workspace, pending);
            requireCommandSuccess(
              await runCommand(
                workspace,
                createIsolatedProjectCommand({
                  projectRoot: PROJECT_ROOT,
                  isolatedRoot: snapshotRoot,
                  quote: shellQuote,
                }),
                {
                  cwd: PROJECT_ROOT,
                  backend: 'container-shell',
                  timeoutMs: 2 * 60_000,
                },
              ),
            );
            await this.assertPreviewCheckpoint(expectedWorkspaceRevision, expectedSnapshotRevision, false);
            requireCommandSuccess(await runNativeCommand(workspace, snapshotRoot, INSTALL_COMMAND, 4 * 60_000));
            requireCommandSuccess(
              await runNativeCommand(workspace, snapshotRoot, 'pnpm run build:isolated-preview', 5 * 60_000),
            );
            await this.assertPreviewCheckpoint(expectedWorkspaceRevision, expectedSnapshotRevision, false);
            const handle = await workspace.runtime.exec(
              createContainerDirectoryCommand({
                directory: snapshotRoot,
                command: `pnpm exec vite preview --mode ghostbuild-isolated-preview --host 0.0.0.0 --port ${port} --strictPort`,
                quote: shellQuote,
              }),
              {
                cwd: PROJECT_ROOT,
                backend: 'container-shell',
                env: { __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: '.trycloudflare.com,container' },
                id: execId,
                timeoutMs: PREVIEW_TTL_MS,
                encoding: 'utf8',
              },
            );
            handle[Symbol.dispose]();
          });
          await waitForHttpPort(this.ctx.container!.getTcpPort(port));
          const tunnel = await openPreviewQuickTunnel(this.tunnels, port);
          await this.assertPreviewCheckpoint(expectedWorkspaceRevision, expectedSnapshotRevision, false);
          this.requirePreviewNotCancelled(previewId);
          await this.setKeepAlive(true);
          await this.schedule(PREVIEW_TTL_MS / 1_000, 'expirePreview', { previewId });
          this.requirePreviewNotCancelled(previewId);
          const now = Date.now();
          this.ctx.storage.transactionSync(() => {
            this.ctx.storage.sql.exec(
              `INSERT INTO ghostbuild_active_preview (
               singleton, preview_id, exec_id, port, snapshot_root, snapshot_revision,
               workspace_revision, activated_at
             ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(singleton) DO UPDATE SET
               preview_id = excluded.preview_id,
               exec_id = excluded.exec_id,
               port = excluded.port,
               snapshot_root = excluded.snapshot_root,
               snapshot_revision = excluded.snapshot_revision,
               workspace_revision = excluded.workspace_revision,
               activated_at = excluded.activated_at`,
              previewId,
              execId,
              port,
              snapshotRoot,
              expectedSnapshotRevision,
              expectedWorkspaceRevision,
              now,
            );
            this.ctx.storage.sql.exec(
              `INSERT INTO ghostbuild_preview_results (
                 preview_id, url, snapshot_revision, workspace_revision, ready_at, expires_at
               ) VALUES (?, ?, ?, ?, ?, ?)`,
              previewId,
              tunnel.url,
              expectedSnapshotRevision,
              expectedWorkspaceRevision,
              now,
              now + PREVIEW_TTL_MS,
            );
          });
          published = true;
          if (previous && previous.preview_id !== previewId) {
            await this.cleanupPreviewResources(previous).catch((error) =>
              console.warn('Unable to retire the superseded ProjectWorkspace preview', {
                previewId: previous.preview_id,
                error: error instanceof Error ? error.message : String(error),
              }),
            );
          }
          return {
            id: previewId,
            url: tunnel.url,
            workspaceRevision: expectedWorkspaceRevision,
            snapshotRevision: expectedSnapshotRevision,
            readyAt: new Date(now).toISOString(),
            expiresAt: new Date(now + PREVIEW_TTL_MS).toISOString(),
          };
        } finally {
          if (!published) {
            await this.cleanupPreviewResources(pending).catch(() => undefined);
            if (!previous) {
              await this.setKeepAlive(false).catch(() => undefined);
            }
          }
        }
      },
    );
  }

  async stopPreview(previewIdValue: unknown) {
    const previewId = requirePreviewId(previewIdValue);
    this.ctx.storage.sql.exec(
      `INSERT INTO ghostbuild_preview_cancellations (preview_id, cancelled_at) VALUES (?, ?)
       ON CONFLICT(preview_id) DO UPDATE SET cancelled_at = excluded.cancelled_at`,
      previewId,
      Date.now(),
    );
    this.ctx.storage.sql.exec('DELETE FROM ghostbuild_preview_results WHERE preview_id = ?', previewId);
    this.ctx.storage.sql.exec(
      `DELETE FROM ghostbuild_preview_cancellations WHERE preview_id IN (
         SELECT preview_id FROM ghostbuild_preview_cancellations
         ORDER BY cancelled_at DESC LIMIT -1 OFFSET 500
       )`,
    );
    await this.withStatefulOperation('preview', `preview:stop:${previewId}`, async () => {
      const row = this.activePreviewRow();
      if (row?.preview_id === previewId) {
        await this.stopActivePreview();
      }
    });
  }

  async expirePreview(value: unknown) {
    await this.stopPreview(record(value).previewId);
  }

  async prepareDeploymentArtifact(value: unknown): Promise<PreparedDeploymentArtifact> {
    this.requireCompletedComputerSync();
    const input = record(value);
    const sessionId = requireString(input.sessionId, 'sessionId', 256);
    const revision = requireString(input.revision, 'revision', 64);
    const session = this.requireActiveDeploymentSession(sessionId);
    if (revision !== session.expected_snapshot_revision) {
      throw new Error('The deployment artifact revision does not match its active deployment session.');
    }
    this.#activeOperationOwners.add(session.owner);
    const operation = async () => {
      await this.assertDeploymentSession({ sessionId });
      if (!/^[a-f0-9]{64}$/.test(revision) || !this.hasSuccessfulValidation(revision)) {
        throw new Error('Deployment requires successful validation of this exact revision.');
      }
      if ((await this.checkpoint()).revision !== revision) {
        throw new Error('The durable project changed after validation. Run full validation again.');
      }
      const accountId = requireString(input.accountId, 'accountId', 64);
      const workerName = requireCloudflareName(input.workerName, 'workerName');
      const projectType =
        input.projectType === 'worker' ? 'worker' : input.projectType === 'web_app' ? 'web_app' : null;
      if (!projectType) {
        throw new SyntaxError('Invalid deployment project type.');
      }
      const isolatedRoot = `${ISOLATED_PROJECT_ROOT}/deployment-${crypto.randomUUID()}`;
      const wranglerConfigPath = `${isolatedRoot}/.ghostbuild-deploy.json`;
      const artifactRoot = `${isolatedRoot}/.ghostbuild-artifact`;
      let artifact: PreparedDeploymentArtifact;
      try {
        artifact = await this.withComputer(async (workspace) => {
          requireCommandSuccess(
            await runCommand(
              workspace,
              createIsolatedProjectCommand({ projectRoot: PROJECT_ROOT, isolatedRoot, quote: shellQuote }),
              { cwd: PROJECT_ROOT, backend: 'container-shell', timeoutMs: 2 * 60_000 },
            ),
          );
          await this.assertDeploymentSession({ sessionId });
          requireCommandSuccess(await runNativeCommand(workspace, isolatedRoot, INSTALL_COMMAND, 4 * 60_000));
          for (const command of ['pnpm run typecheck', 'pnpm run verify:stack', 'pnpm run build', 'pnpm run lint']) {
            requireCommandSuccess(await runNativeCommand(workspace, isolatedRoot, command, 5 * 60_000));
          }
          const configWrite = await this.writeFile(
            wranglerConfigPath,
            JSON.stringify(
              rebaseDeploymentConfigPaths(
                createTrustedDeploymentConfig({ ...input, accountId, workerName, projectType }),
                { projectRoot: PROJECT_ROOT, isolatedRoot },
              ),
            ),
            { encoding: 'utf-8' },
          );
          if (!configWrite.success) {
            throw new Error('The isolated deployment configuration could not be written.');
          }
          requireCommandSuccess(
            await runNativeCommand(
              workspace,
              isolatedRoot,
              `pnpm exec wrangler deploy --dry-run --outdir ${shellQuote(artifactRoot)} --config ${shellQuote(wranglerConfigPath)}`,
              10 * 60_000,
            ),
          );
          return {
            revision,
            mainModule: projectType === 'worker' ? 'server.js' : 'index.js',
            modules: await collectSandboxFiles(this, artifactRoot, (path) => /\.(?:js|mjs|wasm)$/.test(path)),
            assets:
              projectType === 'web_app'
                ? await collectSandboxFiles(
                    this,
                    `${isolatedRoot}/dist/client`,
                    (path) => path !== '.assetsignore' && !path.endsWith('.map'),
                  )
                : [],
            migrations: {
              DB:
                typeof input.d1DatabaseId === 'string'
                  ? await collectSandboxMigrations(this, `${isolatedRoot}/migrations`)
                  : [],
              AGENT_SECURITY_DB:
                typeof input.agentSecurityD1DatabaseId === 'string'
                  ? await collectSandboxMigrations(this, `${isolatedRoot}/agent-security-migrations`)
                  : [],
            },
          };
        });
      } finally {
        await this.withComputer((workspace) =>
          runCommand(workspace, `rm -rf ${shellQuote(isolatedRoot)}`, {
            cwd: PROJECT_ROOT,
            backend: 'container-shell',
            timeoutMs: 30_000,
          }),
        ).catch(() => undefined);
      }
      if ((await this.checkpoint()).revision !== revision) {
        throw new Error('The project changed while its deployment artifact was prepared. Validate the new revision.');
      }
      await this.assertDeploymentSession({ sessionId });
      return validatePreparedDeploymentArtifact(artifact, { revision, projectType });
    };
    try {
      return await this.withContainerKeepAlive(operation);
    } finally {
      this.#activeOperationOwners.delete(session.owner);
    }
  }

  async deleteProject() {
    await this.withStatefulOperation('delete', 'delete:project', async () => {
      await this.stopActivePreview();
      await this.withComputer((workspace) => workspace.fs.rm(PROJECT_ROOT, { recursive: true, force: true }));
      this.ctx.storage.sql.exec('DELETE FROM ghostbuild_validations');
      this.ctx.storage.sql.exec(
        `UPDATE ghostbuild_workspace_state
         SET initialized = 0, seed_id = NULL, reset_revision = ?
         WHERE singleton = 1`,
        this.currentRevision(),
      );
    });
    await this.destroy().catch(() => undefined);
  }

  private async stopActivePreview() {
    const row = this.activePreviewRow();
    this.deleteSchedules('expirePreview');
    if (row) {
      await this.cleanupPreviewResources(row);
    }
    await this.setKeepAlive(false).catch(() => undefined);
    this.ctx.storage.sql.exec('DELETE FROM ghostbuild_active_preview WHERE singleton = 1');
  }

  private async cleanupPreviewResources(row: ActivePreviewRow): Promise<void> {
    await this.tunnels.destroy(row.port).catch(() => undefined);
    await this.withComputer((workspace) => cleanupPreviewProcess(workspace, row));
  }

  private activePreviewRow(): ActivePreviewRow | null {
    return (
      first(
        this.ctx.storage.sql.exec<ActivePreviewRow>(
          `SELECT preview_id, exec_id, port, snapshot_root, snapshot_revision, workspace_revision
           FROM ghostbuild_active_preview WHERE singleton = 1`,
        ),
      ) ?? null
    );
  }

  private previewResultRow(previewId: string): PreviewResultRow | null {
    return (
      first(
        this.ctx.storage.sql.exec<PreviewResultRow>(
          `SELECT preview_id, url, snapshot_revision, workspace_revision, ready_at, expires_at
           FROM ghostbuild_preview_results WHERE preview_id = ?`,
          previewId,
        ),
      ) ?? null
    );
  }

  private async assertPreviewCheckpoint(
    expectedWorkspaceRevision: number,
    expectedSnapshotRevision: string,
    requireWorkspaceRevision: boolean,
  ) {
    const checkpoint = await this.checkpoint();
    return assertPreviewSourceCheckpoint(
      checkpoint,
      {
        workspaceRevision: expectedWorkspaceRevision,
        revision: expectedSnapshotRevision,
      },
      requireWorkspaceRevision,
    );
  }

  private requirePreviewNotCancelled(previewId: string): void {
    const cancelled = first(
      this.ctx.storage.sql.exec<{ found: number }>(
        'SELECT 1 AS found FROM ghostbuild_preview_cancellations WHERE preview_id = ? LIMIT 1',
        previewId,
      ),
    );
    assertPreviewPublicationAllowed(Boolean(cancelled));
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

  private deploymentSessionRow(operationId: string): DeploymentSessionRow | null {
    return (
      first(
        this.ctx.storage.sql.exec<DeploymentSessionRow>(
          `SELECT operation_id, owner, idempotency_key, expected_workspace_revision,
                  expected_snapshot_revision, acquired_at, deadline, status
           FROM ghostbuild_deployment_sessions WHERE operation_id = ?`,
          operationId,
        ),
      ) ?? null
    );
  }

  private requireActiveDeploymentSession(operationId: string): DeploymentSessionRow {
    const session = this.deploymentSessionRow(operationId);
    if (!session || session.status !== 'active') {
      throw new WorkspaceOperationIndeterminateError('deployment');
    }
    return session;
  }

  private deploymentSessionLease(session: DeploymentSessionRow): WorkspaceOperationLease {
    const lease = this.#operationLane.find(session.idempotency_key, session.owner);
    if (!lease) {
      throw new WorkspaceOperationIndeterminateError('deployment');
    }
    return lease;
  }

  private currentRevision(): number {
    return first(this.ctx.storage.sql.exec<{ v: number }>("SELECT v FROM vfs_meta WHERE k = 'rev'"))?.v ?? 0;
  }

  private workspaceRow(): {
    initialized: number;
    seed_id: string | null;
    reset_revision: number;
  } {
    const row = first(
      this.ctx.storage.sql.exec<{
        initialized: number;
        seed_id: string | null;
        reset_revision: number;
      }>(
        `SELECT initialized, seed_id, reset_revision
         FROM ghostbuild_workspace_state WHERE singleton = 1`,
      ),
    );
    if (!row) {
      throw new Error('The Computer workspace state is unavailable.');
    }
    return row;
  }

  private stateFromFiles(files: WorkspaceFile[], revision = this.currentRevision()): WorkspaceState {
    const row = this.workspaceRow();
    return {
      initialized: row.initialized === 1,
      revision,
      resetRevision: row.reset_revision,
      fileCount: files.length,
      totalBytes: totalFileBytes(files),
      seeding: row.seed_id !== null,
    };
  }

  private async stableProjectRead<T>(read: (workspace: WorkspaceClient) => Promise<T>): Promise<{
    value: T;
    revision: number;
  }> {
    return stableWorkspaceRead(
      () => this.currentRevision(),
      () => this.withComputer(read),
    );
  }

  private async runToolOperation<T>(
    toolCallId: string,
    toolName: string,
    args: unknown,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      this.requireCompletedComputerSync();
    } catch (error) {
      if (error instanceof WorkspaceSyncPendingError) {
        return pendingComputerSyncToolResult(error) as T;
      }
      throw error;
    }
    const argsJson = JSON.stringify(stableValue(args)) ?? 'null';
    const started = this.#toolOperations.begin({
      toolCallId,
      toolName,
      argsSha256: await sha256Text(argsJson),
    });
    if (started.status === 'completed') {
      return started.result as T;
    }
    if (started.status === 'failed' || started.status === 'indeterminate') {
      throw new Error(started.error);
    }
    try {
      const result = await operation();
      return this.#toolOperations.complete({ toolCallId, result }) as T;
    } catch (error) {
      if (error instanceof WorkspaceSyncPendingError) {
        const result =
          error.commandResult && error.commandResult.exitCode !== 0
            ? toolFailure(commandFailureMessage(error.commandResult), {
                buildEnvironment: 'cloudflare-computer-container',
                nextAction: toolName === 'npmInstall' ? 'install-dependencies' : 'validate-project',
              })
            : pendingComputerSyncToolResult(error);
        this.registerPendingCommand({ backend: error.backend, toolCallId, result });
        return result as T;
      }
      try {
        this.#toolOperations.fail({
          toolCallId,
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {
        // A completed journal row wins if its acknowledgement was interrupted.
      }
      throw error;
    }
  }

  private async withStatefulOperation<T>(
    kind: StatefulOperationKind,
    idempotencyKey: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.requireCompletedComputerSync();
    const owner = crypto.randomUUID();
    const lease = this.#operationLane.acquire({
      owner,
      idempotencyKey,
      kind,
      leaseMs: OPERATION_LEASE_MS[kind],
    });
    this.#activeOperationOwners.add(owner);
    if (lease.recoveredOwner) {
      console.info('ProjectWorkspace operation lease recovered', {
        kind,
      });
    }
    try {
      return await this.withContainerKeepAlive(operation);
    } finally {
      this.#operationLane.release(lease);
      this.#activeOperationOwners.delete(owner);
    }
  }

  private async withContainerKeepAlive<T>(operation: () => Promise<T>): Promise<T> {
    this.#containerKeepAliveOperations += 1;
    try {
      await this.setKeepAlive(true);
      return await operation();
    } finally {
      this.#containerKeepAliveOperations -= 1;
      if (this.#containerKeepAliveOperations === 0 && !this.activePreviewRow()) {
        await this.setKeepAlive(false).catch(() => undefined);
      }
    }
  }

  private requireCompletedComputerSync(): void {
    requireWorkspaceSyncBarrier(this.#toolOperations.pending(), (backend) => this.#syncRetries.state(backend));
  }

  private finishPendingCommand(backend: string): void {
    const continuation = this.#toolOperations.pending().find((operation) => operation.backend === backend);
    if (!continuation) {
      return;
    }
    this.#toolOperations.completePending(backend, continuation.result);
  }

  private async recoverExhaustedComputerSync(backend: string): Promise<boolean> {
    const active = this.#activeSyncRecoveries.get(backend);
    if (active) {
      return active;
    }
    const recovery = (async () => {
      try {
        // Exhaustion may be tied to a stale Computer connection. A closed
        // Workspace reconnects lazily, so the following pull is proof from a
        // fresh backend handle rather than another attempt on the failed one.
        await this.#workspace.close();
        await this.#workspace.pull(backend);
        this.finishPendingCommand(backend);
        await this.#syncRetries.clear(backend);
        await this.cleanupReadinessRoot().catch(() => undefined);
        return true;
      } catch (error) {
        console.warn('ProjectWorkspace exhausted Computer sync recovery remains pending', {
          backend,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    })();
    this.#activeSyncRecoveries.set(backend, recovery);
    try {
      return await recovery;
    } finally {
      if (this.#activeSyncRecoveries.get(backend) === recovery) {
        this.#activeSyncRecoveries.delete(backend);
      }
    }
  }

  private registerPendingCommand(args: { backend: string; toolCallId: string; result: unknown }): void {
    this.#toolOperations.registerPending(args);
    this.ctx.waitUntil(this.reconcilePendingCommands());
  }

  private async schedulePendingCommandRecovery(delayMs: number): Promise<void> {
    const schedule = this.schedule as unknown as (
      when: number,
      callback: string,
      payload: unknown,
      options: { idempotent: true },
    ) => Promise<unknown>;
    const delaySeconds = Math.max(1, Math.ceil(delayMs / 1_000));
    await schedule.call(
      this,
      delaySeconds,
      'reconcilePendingCommands',
      { notBefore: Date.now() + delaySeconds * 1_000 },
      { idempotent: true },
    );
  }

  private async cleanupReadinessRoot(): Promise<void> {
    await this.withComputer((workspace) => workspace.fs.rm(READINESS_ROOT, { recursive: true, force: true }));
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
    const controlPlaneResponse = await routeUserWorkspaceRuntimeControlPlaneRequest(request, env);
    if (controlPlaneResponse) {
      return controlPlaneResponse;
    }
    return handleUserRequest(request, env, url, ctx);
  },
  scheduled(controller: ScheduledController, env: RuntimeEnv, ctx: ExecutionContext): void {
    scheduleUserWorkspaceRuntimeMaintenance(controller, env, ctx);
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
    if (isMissingPath(error)) {
      return [];
    }
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

type SandboxFileAccess = Pick<ProjectWorkspace, 'exists' | 'listFiles' | 'readFile'>;

async function collectSandboxFiles(
  sandbox: SandboxFileAccess,
  root: string,
  include: (relativePath: string) => boolean,
): Promise<DeploymentArtifactFile[]> {
  const listing = await sandbox.listFiles(root, { recursive: true, includeHidden: true });
  if (!listing.success) {
    throw new Error('The prepared deployment artifact could not be listed.');
  }
  const entries = listing.files.filter((entry) => entry.type === 'file');
  if (entries.length > MAX_DEPLOYMENT_ARTIFACT_FILES) {
    throw new Error('The prepared deployment artifact has too many files.');
  }
  const files: DeploymentArtifactFile[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    const relativePath = relativeIsolatedPath(root, entry.absolutePath);
    if (!relativePath || !include(relativePath)) {
      continue;
    }
    if (entry.size > MAX_FILE_BYTES) {
      throw new Error(`Deployment artifact file is too large: ${relativePath}`);
    }
    const file = await sandbox.readFile(entry.absolutePath, { encoding: 'none' });
    const bytes = await readStream(file.content, file.size);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_DEPLOYMENT_ARTIFACT_BYTES) {
      throw new Error('The prepared deployment artifact exceeds its aggregate size limit.');
    }
    files.push({ path: relativePath, bytes, size: bytes.byteLength, sha256: await sha256Bytes(bytes) });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function collectSandboxMigrations(
  sandbox: SandboxFileAccess,
  root: string,
): Promise<Array<{ name: string; sql: string }>> {
  if (!(await sandbox.exists(root)).exists) {
    return [];
  }
  const listing = await sandbox.listFiles(root, { recursive: true, includeHidden: true });
  if (!listing.success) {
    throw new Error('Deployment migrations could not be listed.');
  }
  const migrations: Array<{ name: string; sql: string }> = [];
  for (const entry of listing.files.filter((candidate) => candidate.type === 'file')) {
    const name = requireDeploymentMigrationName(relativeIsolatedPath(root, entry.absolutePath));
    if (entry.size > MAX_FILE_BYTES) {
      throw new Error(`Deployment migration is too large: ${name}`);
    }
    const file = await sandbox.readFile(entry.absolutePath, { encoding: 'none' });
    const sql = decodeUtf8(await readStream(file.content, file.size));
    if (!sql.trim()) {
      throw new Error(`Deployment migration is empty: ${name}`);
    }
    migrations.push({ name, sql });
  }
  return migrations.sort((left, right) => left.name.localeCompare(right.name));
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

async function runCommand(
  workspace: WorkspaceClient,
  command: string,
  options: {
    cwd: string;
    backend: 'container-shell';
    timeoutMs: number;
    env?: Record<string, string>;
    onSyncPending?: (result: WorkspaceRuntimeResult<'utf8'>) => void;
  },
): Promise<WorkspaceRuntimeResult<'utf8'>> {
  const handle = await workspace.runtime.exec(command, {
    cwd: options.cwd,
    backend: options.backend,
    encoding: 'utf8',
    timeoutMs: options.timeoutMs,
    env: options.env,
  });
  try {
    const result = await handle.result();
    if (result.sync.status === 'pending') {
      options.onSyncPending?.(result);
    }
    return requireDurableCommandResult(result, options.backend);
  } finally {
    const id = handle.id;
    handle[Symbol.dispose]();
    await workspace.runtime.disposeExec(id, { backend: options.backend }).catch(() => undefined);
  }
}

function requireCommandSuccess(result: WorkspaceRuntimeResult<'utf8'>): void {
  if (result.exitCode !== 0) {
    throw new Error(commandFailureMessage(result));
  }
}

function commandFailureMessage(result: Pick<WorkspaceRuntimeResult<'utf8'>, 'stderr' | 'stdout'>): string {
  return `${result.stderr}\n${result.stdout}`.trim().slice(-4_000) || 'The Computer command failed.';
}

function pendingComputerSyncToolResult(error: WorkspaceSyncPendingError): GhostbuildToolResult {
  return toolFailure(
    error.code === 'workspace_sync_exhausted'
      ? 'Cloudflare Computer could not confirm the durable project filesystem. The execution backend is being recovered; retry this operation.'
      : 'Cloudflare Computer is still saving the project filesystem. Retry this operation after synchronization completes.',
    {
      state: error.code,
      backend: error.backend,
      attempt: error.attempt,
      retryAfterMs: Math.max(0, error.notBefore - Date.now()),
      buildEnvironment: 'cloudflare-computer-container',
      nextAction: 'retry-operation',
    },
  );
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

function workspaceFileMetadata(file: WorkspaceFile, revision: number) {
  return {
    path: file.path,
    encoding: canDecodeUtf8(file.bytes) ? ('utf8' as const) : ('base64' as const),
    size: file.size,
    mode: file.mode,
    sha256: file.sha256,
    revision,
  };
}

function previewSuccess(row: PreviewResultRow) {
  return {
    id: row.preview_id,
    url: row.url,
    workspaceRevision: row.workspace_revision,
    snapshotRevision: row.snapshot_revision,
    readyAt: new Date(row.ready_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
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
      encoding: requireWorkspaceFileEncoding(entry.encoding),
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
      encoding: requireWorkspaceFileEncoding(change.encoding),
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

function requireBackend(value: unknown): 'container-shell' {
  if (value === undefined || value === 'container-shell') {
    return 'container-shell';
  }
  throw new SyntaxError('Invalid Computer execution backend.');
}

function requireRemoteToolName(value: unknown): 'write' | 'edit' | 'exec' | 'deploy' {
  if (value === 'write' || value === 'edit' || value === 'exec' || value === 'deploy') {
    return value;
  }
  throw new SyntaxError('Invalid stateful workspace tool name.');
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
    if (done) {
      break;
    }
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

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SyntaxError('Workspace request must be an object.');
  }
  return value as Record<string, unknown>;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
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

function requirePreviewId(value: unknown): string {
  const previewId = requireString(value, 'previewId', 128);
  if (!/^[a-zA-Z0-9_-]+$/.test(previewId)) {
    throw new SyntaxError('Invalid previewId.');
  }
  return previewId;
}

function requireSnapshotRevision(value: unknown): string {
  const revision = requireString(value, 'expectedSnapshotRevision', 64);
  if (!/^[a-f0-9]{64}$/.test(revision)) {
    throw new SyntaxError('Invalid expectedSnapshotRevision.');
  }
  return revision;
}

function assertDeploymentSessionIdentity(
  session: DeploymentSessionRow,
  expectedWorkspaceRevision: number,
  expectedSnapshotRevision: string,
): void {
  if (
    session.expected_workspace_revision !== expectedWorkspaceRevision ||
    session.expected_snapshot_revision !== expectedSnapshotRevision
  ) {
    throw new Error('A deployment operation identifier was reused for a different workspace revision.');
  }
}

function requireSandboxExecSuccess(result: { success: boolean; stdout: string; stderr: string }): void {
  if (!result.success) {
    throw new Error(`${result.stderr}\n${result.stdout}`.trim() || 'The Sandbox bootstrap command failed.');
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function runNativeCommand(workspace: WorkspaceClient, directory: string, command: string, timeoutMs: number) {
  return runCommand(workspace, createContainerDirectoryCommand({ directory, command, quote: shellQuote }), {
    cwd: PROJECT_ROOT,
    backend: 'container-shell',
    timeoutMs,
  });
}

async function cleanupPreviewProcess(
  workspace: WorkspaceClient,
  row: Pick<ActivePreviewRow, 'exec_id' | 'snapshot_root'>,
) {
  await workspace.runtime
    .killExec(row.exec_id, { backend: 'container-shell', signal: 'SIGKILL' })
    .catch(() => undefined);
  await workspace.runtime.disposeExec(row.exec_id, { backend: 'container-shell' }).catch(() => undefined);
  const result = await runCommand(workspace, `rm -rf ${shellQuote(row.snapshot_root)}`, {
    cwd: PROJECT_ROOT,
    backend: 'container-shell',
    timeoutMs: 30_000,
  });
  requireCommandSuccess(result);
}

async function sha256Bytes(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(value).buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function sha256Text(value: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(value));
}

function first<T>(rows: Iterable<T>): T | undefined {
  for (const row of rows) {
    return row;
  }
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

export { BuilderAgent };
