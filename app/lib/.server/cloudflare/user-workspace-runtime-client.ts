import type { GhostbuildToolResult } from 'ghostbuild-agent/tool-result';
import { computerSyncUnconfirmedError, isComputerSyncUnconfirmedError } from 'ghostbuild-agent/cloudflare-computer';
import type {
  BuilderWorkspaceApi,
  BuilderWorkspaceCheckpoint,
  BuilderWorkspaceFileMetadata,
  ProjectWorkspaceRpc,
} from '~/agents/builder-workspace-api';
import type {
  BuilderWorkspaceApplyResult,
  BuilderWorkspaceSeedStartResult,
  BuilderWorkspaceState,
  BuilderWorkspaceSyncPage,
} from '~/agents/builder-workspace-types';
type ProjectWorkspaceStub = DurableObjectStub<ProjectWorkspaceRpc>;

type ToolOperationStartResult =
  | { status: 'execute' }
  | { status: 'completed'; result: unknown }
  | { status: 'failed' | 'indeterminate'; error: string };

/** Typed in-process facade over the co-deployed ProjectWorkspace Durable Object. */
export class UserWorkspaceRuntimeClient implements BuilderWorkspaceApi {
  readonly #inFlight = new Map<string, { toolName: string; argsJson: string; promise: Promise<unknown> }>();
  #state: BuilderWorkspaceState | null = null;
  #files: BuilderWorkspaceFileMetadata[] = [];
  #stubPromise: Promise<ProjectWorkspaceStub> | null = null;
  #activeTool: { toolCallId: string; toolName: string } | null = null;

  readonly computer: BuilderWorkspaceApi['computer'] = {
    fs: {
      stat: async (path) => {
        const file = this.#files.find((candidate) => candidate.path === path);
        if (!file) {
          const error = new Error(`ENOENT: no such file: ${path}`) as Error & { code: string };
          error.code = 'ENOENT';
          throw error;
        }
        return {
          size: file.size,
          mtime: file.revision,
          mode: file.mode,
          isFile: true,
          isDirectory: false,
        };
      },
      readFile: async (path) => (await this.#stub()).streamWorkspaceFile(path),
      writeFile: async (path, content, options) => {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(content);
        const result = await this.applyClientChanges({
          baseRevision: this.getState().revision,
          changes: [{ kind: 'write', path, content: text, mode: options?.mode }],
          ...(this.#activeTool
            ? { operationKey: `tool:${this.#activeTool.toolCallId}`, toolCallId: this.#activeTool.toolCallId }
            : {}),
        });
        if (!result.ok) {
          throw new Error('The project changed while the file was being written. Retry the operation.');
        }
      },
      mkdir: async (path) => {
        await (await this.#stub()).makeDirectory(path);
        await this.refresh();
      },
      rm: async (path) => {
        const result = await this.applyClientChanges({
          baseRevision: this.getState().revision,
          changes: [{ kind: 'delete', path }],
          ...(this.#activeTool
            ? { operationKey: `tool:${this.#activeTool.toolCallId}`, toolCallId: this.#activeTool.toolCallId }
            : {}),
        });
        if (!result.ok) {
          throw new Error('The project changed while the path was being removed. Retry the operation.');
        }
      },
      readdir: async (path) => (await this.#stub()).readDirectory(path),
    },
    runtime: {
      exec: async (command, options) => ({
        result: async () =>
          (await this.#stub()).execute({
            command,
            cwd: options.cwd,
            backend: options.backend,
            ...(this.#activeTool ? { operationKey: `tool:${this.#activeTool.toolCallId}` } : {}),
          }),
      }),
    },
  };

  constructor(
    private readonly env: Env,
    private readonly projectId: string,
    private readonly getUserId: () => string | null,
  ) {}

  async refresh(): Promise<BuilderWorkspaceState> {
    const stub = await this.#stub();
    const snapshot = await stub.getWorkspaceSnapshot();
    this.#state = snapshot.state;
    this.#files = snapshot.files;
    return snapshot.state;
  }

  getState(): BuilderWorkspaceState {
    if (!this.#state) {
      throw new Error('The user-owned project workspace has not been loaded.');
    }
    return this.#state;
  }

  async beginSeed(seedId: unknown): Promise<BuilderWorkspaceSeedStartResult> {
    const result = await (await this.#stub()).beginSeed(seedId);
    this.#state = result.state;
    return result;
  }

  async appendSeed(seedId: unknown, entries: unknown): Promise<BuilderWorkspaceState> {
    return this.#setState(await (await this.#stub()).appendSeed(seedId, entries));
  }

  async commitSeed(seedId: unknown, expected: unknown): Promise<BuilderWorkspaceState> {
    const state = this.#setState(await (await this.#stub()).commitSeed(seedId, expected));
    await this.refresh();
    return state;
  }

  async abortSeed(seedId: unknown): Promise<BuilderWorkspaceState> {
    return this.#setState(await (await this.#stub()).abortSeed(seedId));
  }

  async applyClientChanges(value: unknown): Promise<BuilderWorkspaceApplyResult> {
    const result = await (await this.#stub()).applyChanges(value);
    this.#state = result.state;
    if (result.ok && result.changedPaths.length > 0) {
      await this.refresh();
    }
    return result;
  }

  async getSyncPage(value: unknown): Promise<BuilderWorkspaceSyncPage> {
    const page = await (await this.#stub()).getSyncPage(value);
    this.#state = page.state;
    return page;
  }

  readText(path: unknown) {
    return this.#stub().then((stub) => stub.readText(path));
  }

  readFile(path: unknown) {
    return this.#stub().then((stub) => stub.readWorkspaceFile(path));
  }

  listFiles(): BuilderWorkspaceFileMetadata[] {
    return this.#files.map((file) => ({ ...file }));
  }

  checkpoint(): Promise<BuilderWorkspaceCheckpoint> {
    return this.#stub().then((stub) => stub.checkpoint());
  }

  async executeToolOnce<T>(toolCallIdValue: unknown, toolName: string, args: unknown, execute: () => Promise<T>) {
    const toolCallId = requireToolCallId(toolCallIdValue);
    const argsJson = JSON.stringify(stableValue(args));
    const existing = this.#inFlight.get(toolCallId);
    if (existing) {
      if (existing.toolName !== toolName || existing.argsJson !== argsJson) {
        throw new Error('A workspace tool-call identifier was reused with different arguments.');
      }
      return (await existing.promise) as T;
    }
    const promise = this.#executeTool<T>(toolCallId, toolName, argsJson, execute);
    this.#inFlight.set(toolCallId, { toolName, argsJson, promise });
    try {
      return await promise;
    } finally {
      this.#inFlight.delete(toolCallId);
    }
  }

  installDependencies(args: {
    toolCallId: string;
    input: unknown;
    mode: 'add' | 'sync-lockfile';
    packages: string[];
  }): Promise<GhostbuildToolResult> {
    return this.#stub()
      .then((stub) => stub.installDependenciesTool(args))
      .then(async (result) => {
        await this.refresh();
        return result;
      });
  }

  validate(args: { toolCallId: string; input: unknown }): Promise<GhostbuildToolResult> {
    return this.#stub().then((stub) => stub.validateTool(args));
  }

  hasSuccessfulValidation(revision: string): Promise<boolean> {
    return this.#stub()
      .then((stub) => stub.validationStatus(revision))
      .then((result) => result.valid);
  }

  prepareDeployment(revision: string): ReturnType<BuilderWorkspaceApi['prepareDeployment']> {
    return this.#stub().then((stub) => stub.deploymentPlan(revision));
  }

  createPreview(args: {
    previewId: string;
    expectedWorkspaceRevision: number;
    expectedSnapshotRevision: string;
  }): ReturnType<BuilderWorkspaceApi['createPreview']> {
    return this.#stub().then((stub) => stub.createPreview(args));
  }

  async stopPreview(previewId: string): Promise<void> {
    await (await this.#stub()).stopPreview(previewId);
  }

  async deleteProject(): Promise<void> {
    await (await this.#stub()).deleteProject();
    this.#state = null;
    this.#files = [];
  }

  async #executeTool<T>(toolCallId: string, toolName: string, argsJson: string, execute: () => Promise<T>) {
    const stub = await this.#stub();
    const started = (await stub.beginToolOperation({ toolCallId, toolName, argsJson })) as ToolOperationStartResult;
    if (started.status === 'completed') {
      if (isPendingMutationReceipt(started.result)) {
        return (await stub.completeToolOperation({ toolCallId, result: started.result })) as T;
      }
      return started.result as T;
    }
    if (started.status === 'failed' || started.status === 'indeterminate') {
      throw new Error(started.error);
    }
    if (this.#activeTool) {
      throw new Error('ProjectWorkspace tools are serialized; a second mutation cannot start concurrently.');
    }
    this.#activeTool = { toolCallId, toolName };
    try {
      const result = await execute();
      const syncError = computerSyncUnconfirmedError(result);
      if (syncError) {
        throw syncError;
      }
      try {
        const completed = await stub.completeToolOperation({ toolCallId, result });
        return (isComputerToolError(result) && isCompletedMutationReceipt(completed) ? completed : result) as T;
      } catch (error) {
        if (toolName !== 'write' && toolName !== 'edit') {
          throw error;
        }
        const replay = (await stub.beginToolOperation({ toolCallId, toolName, argsJson })) as ToolOperationStartResult;
        if (replay.status !== 'completed') {
          throw error;
        }
        const completed = isPendingMutationReceipt(replay.result)
          ? await stub.completeToolOperation({ toolCallId, result })
          : replay.result;
        return (isComputerToolError(result) && isCompletedMutationReceipt(completed) ? completed : result) as T;
      }
    } catch (error) {
      if (!isComputerSyncUnconfirmedError(error)) {
        await stub
          .failToolOperation({
            toolCallId,
            error: error instanceof Error ? error.message : String(error),
          })
          .catch(() => undefined);
      }
      throw error;
    } finally {
      this.#activeTool = null;
    }
  }

  #setState(value: BuilderWorkspaceState): BuilderWorkspaceState {
    this.#state = value;
    return value;
  }

  async #stub(): Promise<ProjectWorkspaceStub> {
    if (this.#stubPromise) {
      return this.#stubPromise;
    }
    this.#stubPromise = this.#resolveStub();
    try {
      return await this.#stubPromise;
    } catch (error) {
      this.#stubPromise = null;
      throw error;
    }
  }

  async #resolveStub(): Promise<ProjectWorkspaceStub> {
    const userId = this.getUserId();
    if (!userId) {
      throw new Error('Agent authentication is required.');
    }
    if (this.env.GHOSTBUILD_USER_RUNTIME !== '1' || this.env.GHOSTBUILD_USER_ID !== userId) {
      throw new Error('The user-owned Cloudflare workspace runtime is not configured for this project owner.');
    }
    const stub = this.env.PROJECT_WORKSPACE.get(this.env.PROJECT_WORKSPACE.idFromName(this.projectId));
    await stub.initializeProjectIdentity({ projectId: this.projectId, userId });
    return stub;
  }
}

function isPendingMutationReceipt(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'workspace-mutation-receipt' &&
    (value as { committed?: unknown }).committed === true &&
    (value as { acknowledgement?: unknown }).acknowledgement === 'pending'
  );
}

function isCompletedMutationReceipt(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'workspace-mutation-receipt' &&
    (value as { committed?: unknown }).committed === true &&
    (value as { acknowledgement?: unknown }).acknowledgement === 'complete'
  );
}

function isComputerToolError(value: unknown): boolean {
  return typeof value === 'object' && value !== null && typeof (value as { error?: unknown }).error === 'string';
}

function requireToolCallId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new Error('Invalid workspace tool-call identifier.');
  }
  return value;
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
