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
  #activeValidationToolCallId: string | null = null;

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

  async executeCommand(args: {
    command: string;
    cwd?: string;
    backend?: string;
    onUpdate?: (partialResult: unknown) => void;
    abortSignal?: AbortSignal;
  }): Promise<{ exitCode: number; stdout: string; stderr: string; streamTruncated?: boolean }> {
    args.abortSignal?.throwIfAborted();
    const stub = await this.#stub();
    const operationKey = this.#activeTool ? `tool:${this.#activeTool.toolCallId}` : undefined;
    const stream = await stub.executeStream({
      command: args.command,
      cwd: args.cwd,
      backend: args.backend,
      ...(operationKey ? { operationKey } : {}),
    });
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let stdout = '';
    let stderr = '';
    let finalResult: { exitCode: number; stdout: string; stderr: string; streamTruncated?: boolean } | undefined;
    let updateTimer: ReturnType<typeof setTimeout> | undefined;
    let lastUpdateAt = 0;
    const emitUpdate = () => {
      updateTimer = undefined;
      lastUpdateAt = Date.now();
      args.onUpdate?.({
        command: args.command,
        cwd: args.cwd ?? null,
        backend: args.backend ?? 'container-shell',
        stdout,
        stderr,
        running: true,
      });
    };
    const scheduleUpdate = () => {
      if (!args.onUpdate) {
        return;
      }
      const delay = 100 - (Date.now() - lastUpdateAt);
      if (delay <= 0) {
        emitUpdate();
      } else {
        updateTimer ??= setTimeout(emitUpdate, delay);
      }
    };
    const cancel = () => {
      if (operationKey) {
        void stub.cancelExecution({ operationKey }).catch(() => undefined);
      }
    };
    args.abortSignal?.addEventListener('abort', cancel, { once: true });
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line) {
            const event = JSON.parse(line) as unknown;
            if (isCommandOutputEvent(event)) {
              if (event.channel === 'stdout') {
                stdout = appendOutputTail(stdout, event.chunk);
              } else {
                stderr = appendOutputTail(stderr, event.chunk);
              }
              scheduleUpdate();
            } else if (isCommandResultEvent(event)) {
              finalResult = {
                exitCode: event.result.exitCode,
                stdout: event.result.stdout,
                stderr: event.result.stderr,
                ...(event.streamTruncated ? { streamTruncated: true } : {}),
              };
            }
          }
          newline = buffer.indexOf('\n');
        }
      }
      if (!finalResult) {
        throw new Error('The command stream ended without a final result.');
      }
      return finalResult;
    } finally {
      if (updateTimer) {
        clearTimeout(updateTimer);
      }
      args.abortSignal?.removeEventListener('abort', cancel);
      reader.releaseLock();
    }
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

  async validate(args: {
    toolCallId: string;
    input: unknown;
    abortSignal?: AbortSignal;
  }): Promise<GhostbuildToolResult> {
    args.abortSignal?.throwIfAborted();
    if (this.#activeValidationToolCallId && this.#activeValidationToolCallId !== args.toolCallId) {
      throw new Error('ProjectWorkspace validation is already running.');
    }
    this.#activeValidationToolCallId = args.toolCallId;
    let cancellation: Promise<void> | undefined;
    const cancel = () => {
      cancellation ??= this.#cancelValidation(args.toolCallId);
      void cancellation.catch(() => undefined);
    };
    args.abortSignal?.addEventListener('abort', cancel, { once: true });
    try {
      const result = await (await this.#stub()).validateTool({ toolCallId: args.toolCallId, input: args.input });
      args.abortSignal?.throwIfAborted();
      return result;
    } finally {
      args.abortSignal?.removeEventListener('abort', cancel);
      try {
        if (args.abortSignal?.aborted) {
          cancel();
          await cancellation;
        }
      } finally {
        if (this.#activeValidationToolCallId === args.toolCallId) {
          this.#activeValidationToolCallId = null;
        }
      }
    }
  }

  async cancelActiveValidation(): Promise<void> {
    const toolCallId = this.#activeValidationToolCallId;
    if (!toolCallId) {
      // The BuilderAgent can restart while ProjectWorkspace still owns the validation.
      await this.#cancelValidation();
      return;
    }
    await this.#cancelValidation(toolCallId);
  }

  async #cancelValidation(toolCallId?: string): Promise<void> {
    await (await this.#stub()).cancelValidation(toolCallId ? { toolCallId } : {});
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
        const committedFileMutation =
          (toolName === 'write' || toolName === 'edit') &&
          isComputerToolError(result) &&
          isCompletedMutationReceipt(completed);
        return (committedFileMutation ? completed : result) as T;
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
    const promise = this.#resolveStub().then((stub) =>
      this.#guardStub(stub, () => {
        if (this.#stubPromise === promise) {
          this.#stubPromise = null;
        }
      }),
    );
    this.#stubPromise = promise;
    try {
      return await promise;
    } catch (error) {
      if (this.#stubPromise === promise) {
        this.#stubPromise = null;
      }
      throw error;
    }
  }

  #guardStub(stub: ProjectWorkspaceStub, invalidate: () => void): ProjectWorkspaceStub {
    return new Proxy(stub, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== 'function') {
          return value;
        }
        return (...args: unknown[]) => {
          try {
            return Promise.resolve(Reflect.apply(value, target, args)).catch((error: unknown) => {
              if (isDurableObjectCodeReset(error)) {
                invalidate();
              }
              throw error;
            });
          } catch (error) {
            if (isDurableObjectCodeReset(error)) {
              invalidate();
            }
            throw error;
          }
        };
      },
    });
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

const COMMAND_UPDATE_TAIL_CHARACTERS = 64 * 1024;

type CommandOutputEvent = { type: 'output'; channel: 'stdout' | 'stderr'; chunk: string };
type CommandResultEvent = {
  type: 'result';
  streamTruncated: boolean;
  result: { exitCode: number; stdout: string; stderr: string };
};

function isCommandOutputEvent(value: unknown): value is CommandOutputEvent {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const event = value as Record<string, unknown>;
  return (
    event.type === 'output' &&
    (event.channel === 'stdout' || event.channel === 'stderr') &&
    typeof event.chunk === 'string'
  );
}

function isCommandResultEvent(value: unknown): value is CommandResultEvent {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const event = value as Record<string, unknown>;
  if (event.type !== 'result' || !event.result || typeof event.result !== 'object') {
    return false;
  }
  const result = event.result as Record<string, unknown>;
  return (
    typeof event.streamTruncated === 'boolean' &&
    typeof result.exitCode === 'number' &&
    typeof result.stdout === 'string' &&
    typeof result.stderr === 'string'
  );
}

function appendOutputTail(current: string, chunk: string): string {
  const next = `${current}${chunk}`;
  return next.length <= COMMAND_UPDATE_TAIL_CHARACTERS ? next : next.slice(-COMMAND_UPDATE_TAIL_CHARACTERS);
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

function isDurableObjectCodeReset(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string' &&
    error.message.includes('Durable Object reset because its code was updated')
  );
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
