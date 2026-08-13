import type { GhostbuildToolResult } from 'ghostbuild-agent/tool-result';
import { computerSyncUnconfirmedError, isComputerSyncUnconfirmedError } from 'ghostbuild-agent/cloudflare-computer';
import {
  WorkspaceToolOperationIndeterminateError,
  type BuilderWorkspaceApi,
  type BuilderWorkspaceCheckpoint,
  type BuilderWorkspaceFileMetadata,
  type ProjectWorkspaceRpc,
} from '~/agents/builder-workspace-api';
import type {
  BuilderWorkspaceApplyResult,
  BuilderWorkspaceSeedStartResult,
  BuilderWorkspaceState,
  BuilderWorkspaceSyncPage,
} from '~/agents/builder-workspace-types';
import { isRetryableDurableObjectError } from '~/lib/cloudflare/durable-object-rpc.server';
type ProjectWorkspaceStub = DurableObjectStub<ProjectWorkspaceRpc>;

type ToolOperationStartResult =
  | { status: 'execute' | 'active' }
  | { status: 'completed'; result: unknown }
  | { status: 'failed' | 'indeterminate'; error: string };

/** Typed in-process facade over the co-deployed ProjectWorkspace Durable Object. */
export class UserWorkspaceRuntimeClient implements BuilderWorkspaceApi {
  readonly #inFlight = new Map<string, { toolName: string; argsJson: string; promise: Promise<unknown> }>();
  readonly #executionCancellations = new Map<string, Promise<void>>();
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
    readonly projectId: string,
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

  async readText(path: unknown, abortSignal?: AbortSignal) {
    abortSignal?.throwIfAborted();
    try {
      return await raceAgainstAbort(
        this.#stub().then((stub) => {
          abortSignal?.throwIfAborted();
          return stub.readText(path);
        }),
        abortSignal,
      );
    } catch (error) {
      if (abortSignal?.aborted) {
        this.#stubPromise = null;
      }
      throw error;
    }
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
    const operationKey = this.#activeTool ? `tool:${this.#activeTool.toolCallId}` : undefined;
    let cancellation: Promise<void> | undefined;
    const cancel = () => {
      if (operationKey) {
        cancellation ??= this.#cancelExecutionUntilSettled(operationKey);
        void cancellation.catch(() => undefined);
      }
    };
    args.abortSignal?.addEventListener('abort', cancel, { once: true });
    let stream: ReadableStream<Uint8Array>;
    try {
      stream = await raceAgainstAbort(
        this.#stub().then((stub) =>
          stub.executeStream({
            command: args.command,
            cwd: args.cwd,
            backend: args.backend,
            ...(operationKey ? { operationKey } : {}),
          }),
        ),
        args.abortSignal,
      );
    } catch (error) {
      args.abortSignal?.removeEventListener('abort', cancel);
      if (args.abortSignal?.aborted) {
        cancel();
        await cancellation;
      }
      if (isRpcStreamDisconnect(error)) {
        throw workspaceCommandDisconnectError(error);
      }
      throw error;
    }
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
      if (args.abortSignal?.aborted) {
        return;
      }
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
    try {
      while (true) {
        args.abortSignal?.throwIfAborted();
        const { done, value } = await raceAgainstAbort(reader.read(), args.abortSignal);
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
      args.abortSignal?.throwIfAborted();
      return finalResult;
    } catch (error) {
      if (args.abortSignal?.aborted) {
        cancel();
        await cancellation;
      }
      if (isDurableObjectTransportReset(error)) {
        this.#stubPromise = null;
      }
      if (isRpcStreamDisconnect(error)) {
        throw workspaceCommandDisconnectError(error);
      }
      throw error;
    } finally {
      if (updateTimer) {
        clearTimeout(updateTimer);
      }
      args.abortSignal?.removeEventListener('abort', cancel);
      if (args.abortSignal?.aborted) {
        this.#stubPromise = null;
      }
      reader.releaseLock();
    }
  }

  async executeToolOnce<T>(
    toolCallIdValue: unknown,
    toolName: string,
    args: unknown,
    execute: () => Promise<T>,
    abortSignal?: AbortSignal,
  ) {
    abortSignal?.throwIfAborted();
    const toolCallId = requireToolCallId(toolCallIdValue);
    const argsJson = JSON.stringify(stableValue(args));
    const existing = this.#inFlight.get(toolCallId);
    if (existing) {
      if (existing.toolName !== toolName || existing.argsJson !== argsJson) {
        throw new Error('A workspace tool-call identifier was reused with different arguments.');
      }
      const result = (await existing.promise) as T;
      abortSignal?.throwIfAborted();
      return result;
    }
    const promise = this.#executeTool<T>(toolCallId, toolName, argsJson, execute, abortSignal);
    this.#inFlight.set(toolCallId, { toolName, argsJson, promise });
    try {
      return await promise;
    } finally {
      this.#inFlight.delete(toolCallId);
    }
  }

  async installDependencies(args: {
    toolCallId: string;
    input: unknown;
    mode: 'add' | 'sync-lockfile';
    packages: string[];
    abortSignal?: AbortSignal;
  }): Promise<GhostbuildToolResult> {
    const { abortSignal, ...input } = args;
    abortSignal?.throwIfAborted();
    let cancellation: Promise<void> | undefined;
    const cancel = () => {
      cancellation ??= settleCancellationActions('dependency installation cancellation', [
        this.#cancelExecutionUntilSettled(`tool:${args.toolCallId}`),
        this.#terminalizeToolOperationAfterExecution(
          args.toolCallId,
          'The workspace tool operation was cancelled after its execution settled.',
        ),
      ]);
      void cancellation.catch(() => undefined);
    };
    abortSignal?.addEventListener('abort', cancel, { once: true });
    try {
      return await raceAgainstAbort(
        this.#stub().then(async (stub) => {
          const result = await stub.installDependenciesTool(input);
          // Installation may have committed before cancellation; refresh before surfacing it.
          await this.refresh();
          return result;
        }),
        abortSignal,
      );
    } finally {
      abortSignal?.removeEventListener('abort', cancel);
      if (abortSignal?.aborted) {
        cancel();
        await cancellation;
      }
    }
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
      return await raceAgainstAbort(
        this.#stub().then((stub) => stub.validateTool({ toolCallId: args.toolCallId, input: args.input })),
        args.abortSignal,
      );
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
    const deadline = Date.now() + SETTLEMENT_OVERALL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        await this.#settlementRpcAttempt(
          () => this.#stub().then((stub) => stub.cancelValidation(toolCallId ? { toolCallId } : {})),
          deadline,
          'workspace validation cancellation',
        );
        return;
      } catch (error) {
        if (!isRetryableSettlementError(error)) {
          throw indeterminateSettlementError('workspace validation cancellation', error);
        }
      }
      if (Date.now() >= deadline) {
        break;
      }
      await delay(Math.min(SETTLEMENT_RETRY_DELAY_MS, deadline - Date.now()));
    }
    throw indeterminateSettlementError('workspace validation cancellation', new SettlementDeadlineError());
  }

  #cancelExecutionUntilSettled(operationKey: string): Promise<void> {
    const existing = this.#executionCancellations.get(operationKey);
    if (existing) {
      return existing;
    }
    const cancellation = this.#performExecutionCancellation(operationKey).finally(() => {
      if (this.#executionCancellations.get(operationKey) === cancellation) {
        this.#executionCancellations.delete(operationKey);
      }
    });
    this.#executionCancellations.set(operationKey, cancellation);
    return cancellation;
  }

  async #performExecutionCancellation(operationKey: string): Promise<void> {
    const deadline = Date.now() + SETTLEMENT_OVERALL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        await this.#settlementRpcAttempt(
          () => this.#stub().then((stub) => stub.cancelExecution({ operationKey })),
          deadline,
          'workspace command cancellation',
        );
        return;
      } catch (error) {
        if (!isRetryableSettlementError(error)) {
          throw indeterminateSettlementError('workspace command cancellation', error);
        }
      }
      if (Date.now() >= deadline) {
        break;
      }
      await delay(Math.min(SETTLEMENT_RETRY_DELAY_MS, deadline - Date.now()));
    }
    throw indeterminateSettlementError('workspace command cancellation', new SettlementDeadlineError());
  }

  async #terminalizeToolOperationAfterExecution(toolCallId: string, error: string): Promise<void> {
    const deadline = Date.now() + SETTLEMENT_OVERALL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const result = await this.#settlementRpcAttempt(
          () => this.#stub().then((stub) => stub.cancelToolOperation({ toolCallId, error })),
          deadline,
          'workspace tool settlement',
        );
        if (result.status === 'settled') {
          return;
        }
      } catch (settlementError) {
        if (!isRetryableSettlementError(settlementError)) {
          throw indeterminateSettlementError('workspace tool settlement', settlementError);
        }
      }
      if (Date.now() >= deadline) {
        break;
      }
      await delay(Math.min(SETTLEMENT_RETRY_DELAY_MS, deadline - Date.now()));
    }
    throw indeterminateSettlementError('workspace tool settlement', new SettlementDeadlineError());
  }

  async #settlementRpcAttempt<T>(operation: () => Promise<T>, deadline: number, description: string): Promise<T> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new SettlementDeadlineError();
    }
    try {
      return await raceAgainstTimeout(
        operation(),
        Math.min(SETTLEMENT_RPC_ATTEMPT_TIMEOUT_MS, remaining),
        () => new SettlementAttemptTimeoutError(description),
      );
    } catch (error) {
      if (error instanceof SettlementAttemptTimeoutError) {
        this.#stubPromise = null;
      }
      throw error;
    }
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

  async #executeTool<T>(
    toolCallId: string,
    toolName: string,
    argsJson: string,
    execute: () => Promise<T>,
    abortSignal?: AbortSignal,
  ) {
    abortSignal?.throwIfAborted();
    let stub: ProjectWorkspaceStub;
    let started: ToolOperationStartResult;
    try {
      stub = await raceAgainstAbort(this.#stub(), abortSignal);
      started = await raceAgainstAbort(
        stub.beginToolOperation({ toolCallId, toolName, argsJson }) as Promise<ToolOperationStartResult>,
        abortSignal,
      );
    } catch (error) {
      if (abortSignal?.aborted) {
        await this.#terminalizeToolOperationAfterExecution(
          toolCallId,
          'The workspace tool operation was cancelled before execution started.',
        );
      }
      throw error;
    }
    if (started.status === 'active') {
      try {
        started = await this.#pollActiveToolReplay(toolCallId, toolName, argsJson, abortSignal);
      } catch (error) {
        if (abortSignal?.aborted) {
          await this.#cancelStartedToolOperation(
            toolCallId,
            toolName,
            'The active workspace tool replay was cancelled.',
          );
        }
        throw error;
      }
    }
    if (started.status === 'completed') {
      if (isPendingMutationReceipt(started.result)) {
        const completed = await raceAgainstAbort(
          stub.completeToolOperation({ toolCallId, result: started.result }) as Promise<T>,
          abortSignal,
        );
        return completed;
      }
      return started.result as T;
    }
    if (started.status === 'failed') {
      throw new Error(started.error);
    }
    if (started.status === 'indeterminate') {
      throw new WorkspaceToolOperationIndeterminateError(started.error);
    }
    if (this.#activeTool) {
      throw new Error('ProjectWorkspace tools are serialized; a second mutation cannot start concurrently.');
    }
    this.#activeTool = { toolCallId, toolName };
    let executionStarted = false;
    let cancellation: Promise<void> | undefined;
    const cancel = () => {
      cancellation ??= this.#cancelStartedToolOperation(
        toolCallId,
        toolName,
        'The workspace tool operation was cancelled after its execution settled.',
      );
      void cancellation.catch(() => undefined);
    };
    abortSignal?.addEventListener('abort', cancel, { once: true });
    if (abortSignal?.aborted) {
      cancel();
    }
    try {
      abortSignal?.throwIfAborted();
      executionStarted = true;
      const result = await execute();
      abortSignal?.throwIfAborted();
      const syncError = computerSyncUnconfirmedError(result);
      if (syncError) {
        throw syncError;
      }
      try {
        abortSignal?.throwIfAborted();
        const completed = await raceAgainstAbort(stub.completeToolOperation({ toolCallId, result }), abortSignal);
        abortSignal?.throwIfAborted();
        const committedFileMutation =
          (toolName === 'write' || toolName === 'edit') &&
          isComputerToolError(result) &&
          isCompletedMutationReceipt(completed);
        return (committedFileMutation ? completed : result) as T;
      } catch (error) {
        abortSignal?.throwIfAborted();
        if (toolName !== 'write' && toolName !== 'edit') {
          throw error;
        }
        if (!isRetryableDurableObjectError(error)) {
          throw error;
        }
        const replay = await raceAgainstAbort(
          stub.beginToolOperation({ toolCallId, toolName, argsJson }) as Promise<ToolOperationStartResult>,
          abortSignal,
        );
        if (replay.status !== 'completed') {
          throw error;
        }
        const completed = isPendingMutationReceipt(replay.result)
          ? await raceAgainstAbort(stub.completeToolOperation({ toolCallId, result }), abortSignal)
          : replay.result;
        return (isComputerToolError(result) && isCompletedMutationReceipt(completed) ? completed : result) as T;
      }
    } catch (error) {
      if (abortSignal?.aborted) {
        cancel();
        await cancellation;
      } else if (!isComputerSyncUnconfirmedError(error)) {
        const message = error instanceof Error ? error.message : String(error);
        if (executionStarted) {
          await this.#terminalizeToolOperationAfterExecution(toolCallId, message);
        } else {
          await stub.failToolOperation({ toolCallId, error: message }).catch(() => undefined);
        }
      }
      throw error;
    } finally {
      abortSignal?.removeEventListener('abort', cancel);
      this.#activeTool = null;
    }
  }

  #cancelStartedToolOperation(toolCallId: string, toolName: string, error: string): Promise<void> {
    const terminalize = this.#terminalizeToolOperationAfterExecution(toolCallId, error);
    return toolName === 'exec'
      ? settleCancellationActions('workspace command and journal cancellation', [
          this.#cancelExecutionUntilSettled(`tool:${toolCallId}`),
          terminalize,
        ])
      : terminalize;
  }

  async #pollActiveToolReplay(
    toolCallId: string,
    toolName: string,
    argsJson: string,
    abortSignal?: AbortSignal,
  ): Promise<Exclude<ToolOperationStartResult, { status: 'active' }>> {
    const deadline = Date.now() + ACTIVE_REPLAY_OVERALL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await raceAgainstAbort(delay(Math.min(ACTIVE_REPLAY_RETRY_DELAY_MS, deadline - Date.now())), abortSignal);
      try {
        const replay = await raceAgainstAbort(
          this.#settlementRpcAttempt(
            () =>
              this.#stub().then(
                (stub) =>
                  stub.beginToolOperation({ toolCallId, toolName, argsJson }) as Promise<ToolOperationStartResult>,
              ),
            deadline,
            'active workspace tool replay observation',
          ),
          abortSignal,
        );
        if (replay.status === 'active') {
          continue;
        }
        if (replay.status === 'execute') {
          throw new Error('An active workspace tool replay unexpectedly lost its durable journal row.');
        }
        return replay;
      } catch (error) {
        if (!isRetryableSettlementError(error)) {
          throw indeterminateSettlementError('active workspace tool replay observation', error);
        }
      }
    }
    throw indeterminateSettlementError('active workspace tool replay observation', new SettlementDeadlineError());
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
              if (isDurableObjectTransportReset(error)) {
                invalidate();
              }
              throw error;
            });
          } catch (error) {
            if (isDurableObjectTransportReset(error)) {
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
const ACTIVE_REPLAY_RETRY_DELAY_MS = 1_000;
const ACTIVE_REPLAY_OVERALL_TIMEOUT_MS = 30_000;
const SETTLEMENT_RPC_ATTEMPT_TIMEOUT_MS = 5_000;
const SETTLEMENT_OVERALL_TIMEOUT_MS = 30_000;
const SETTLEMENT_RETRY_DELAY_MS = 1_000;

class SettlementAttemptTimeoutError extends Error {
  readonly retryable = true;

  constructor(operation: string) {
    super(`${operation} RPC attempt timed out.`);
  }
}

class SettlementDeadlineError extends Error {
  constructor() {
    super('The settlement deadline elapsed.');
  }
}

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

function isRpcStreamDisconnect(error: unknown): boolean {
  return errorMessage(error).includes('ReadableStream received over RPC disconnected prematurely');
}

function isDurableObjectTransportReset(error: unknown): boolean {
  return isRetryableDurableObjectError(error) || isRpcStreamDisconnect(error);
}

function workspaceCommandDisconnectError(cause: unknown): Error {
  return new Error(
    'The workspace command connection dropped before completion. The connection was reset; retry the command.',
    { cause },
  );
}

function errorMessage(error: unknown): string {
  return typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
    ? error.message
    : '';
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function raceAgainstAbort<T>(promise: Promise<T>, abortSignal?: AbortSignal): Promise<T> {
  if (!abortSignal) {
    return promise;
  }
  abortSignal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortSignal.reason);
    abortSignal.addEventListener('abort', abort, { once: true });
    void promise.then(resolve, reject).finally(() => abortSignal.removeEventListener('abort', abort));
  });
}

function raceAgainstTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutError: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(timeoutError()), Math.max(0, timeoutMs));
    void promise.then(resolve, reject).finally(() => clearTimeout(timeout));
  });
}

async function settleCancellationActions(operation: string, actions: Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(actions);
  const failures = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  if (failures.length > 0) {
    throw indeterminateSettlementError(
      operation,
      new AggregateError(failures, `Unable to confirm every action required for ${operation}.`),
    );
  }
}

function isRetryableSettlementError(error: unknown): boolean {
  return error instanceof SettlementAttemptTimeoutError || isRetryableDurableObjectError(error);
}

function indeterminateSettlementError(operation: string, cause: unknown): WorkspaceToolOperationIndeterminateError {
  return new WorkspaceToolOperationIndeterminateError(
    `Unable to confirm ${operation}; the workspace operation outcome is indeterminate.`,
    { cause },
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
