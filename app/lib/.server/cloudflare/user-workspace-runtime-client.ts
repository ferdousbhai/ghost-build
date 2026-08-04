import type { GhostbuildToolResult } from 'ghostbuild-agent/tool-result';
import type {
  BuilderWorkspaceApi,
  BuilderWorkspaceCheckpoint,
  BuilderWorkspaceFileMetadata,
} from '~/agents/builder-workspace-api';
import type {
  BuilderWorkspaceApplyResult,
  BuilderWorkspaceSeedStartResult,
  BuilderWorkspaceState,
  BuilderWorkspaceSyncPage,
} from '~/agents/builder-workspace-types';

const MAX_RESPONSE_BYTES = 36 * 1024 * 1024;

type ToolOperationStartResult =
  | { status: 'execute' }
  | { status: 'completed'; result: unknown }
  | { status: 'failed' | 'indeterminate'; error: string };

export class UserWorkspaceRuntimeClient implements BuilderWorkspaceApi {
  readonly #inFlight = new Map<string, { toolName: string; argsJson: string; promise: Promise<unknown> }>();
  #state: BuilderWorkspaceState | null = null;
  #files: BuilderWorkspaceFileMetadata[] = [];
  #endpoint: string | null = null;
  #secret: string | null = null;

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
      readFile: (path) => this.#readStream(path),
      writeFile: async (path, content, options) => {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(content);
        const result = await this.applyClientChanges({
          baseRevision: this.getState().revision,
          changes: [{ kind: 'write', path, content: text, mode: options?.mode }],
        });
        if (!result.ok) {
          throw new Error('The project changed while the file was being written. Retry the operation.');
        }
      },
      mkdir: async (path) => {
        await this.#post('mkdir', { path });
        // Creating a previously missing parent advances the Computer VFS
        // revision. Refresh before the following write performs its CAS.
        await this.refresh();
      },
      rm: async (path) => {
        const result = await this.applyClientChanges({
          baseRevision: this.getState().revision,
          changes: [{ kind: 'delete', path }],
        });
        if (!result.ok) {
          throw new Error('The project changed while the path was being removed. Retry the operation.');
        }
      },
      readdir: (path) => this.#post('directory', { path }),
    },
    runtime: {
      exec: async (command, options) => ({
        result: () => this.#post('exec', { command, cwd: options.cwd, backend: options.backend }),
      }),
    },
  };

  constructor(
    private readonly env: Env,
    private readonly projectId: string,
    private readonly getUserId: () => string | null,
    private readonly request: typeof fetch = fetch,
  ) {}

  async refresh(): Promise<BuilderWorkspaceState> {
    const [state, files] = await Promise.all([
      this.#call<BuilderWorkspaceState>('state', { method: 'GET' }),
      this.#call<BuilderWorkspaceFileMetadata[]>('files', { method: 'GET' }),
    ]);
    this.#state = state;
    this.#files = files;
    return state;
  }

  getState(): BuilderWorkspaceState {
    if (!this.#state) {
      throw new Error('The user-owned project workspace has not been loaded.');
    }
    return this.#state;
  }

  async beginSeed(seedId: unknown): Promise<BuilderWorkspaceSeedStartResult> {
    const result = await this.#post<BuilderWorkspaceSeedStartResult>('seed/begin', { seedId });
    this.#state = result.state;
    return result;
  }

  async appendSeed(seedId: unknown, entries: unknown): Promise<BuilderWorkspaceState> {
    return this.#setState(await this.#post('seed/append', { seedId, entries }));
  }

  async commitSeed(seedId: unknown, expected: unknown): Promise<BuilderWorkspaceState> {
    const state = this.#setState(await this.#post('seed/commit', { seedId, expected }));
    await this.refresh();
    return state;
  }

  async abortSeed(seedId: unknown): Promise<BuilderWorkspaceState> {
    return this.#setState(await this.#post('seed/abort', { seedId }));
  }

  async applyClientChanges(value: unknown): Promise<BuilderWorkspaceApplyResult> {
    const result = await this.#post<BuilderWorkspaceApplyResult>('changes', value);
    this.#state = result.state;
    if (result.ok && result.changedPaths.length > 0) {
      await this.refresh();
    }
    return result;
  }

  async getSyncPage(value: unknown): Promise<BuilderWorkspaceSyncPage> {
    const page = await this.#post<BuilderWorkspaceSyncPage>('sync', value);
    this.#state = page.state;
    return page;
  }

  readText(path: unknown) {
    return this.#post<Awaited<ReturnType<BuilderWorkspaceApi['readText']>>>('read-text', { path });
  }

  async readFile(path: unknown): Promise<Awaited<ReturnType<BuilderWorkspaceApi['readFile']>>> {
    const result = await this.#post<
      Omit<Awaited<ReturnType<BuilderWorkspaceApi['readFile']>>, 'bytes'> & {
        bytes: string;
      }
    >('read-file', { path });
    return { ...result, bytes: decodeBase64(result.bytes) };
  }

  listFiles(): BuilderWorkspaceFileMetadata[] {
    return this.#files.map((file) => ({ ...file }));
  }

  checkpoint(): Promise<BuilderWorkspaceCheckpoint> {
    return this.#post('checkpoint', {});
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
    return this.#post<GhostbuildToolResult>('dependencies', args).then(async (result) => {
      await this.refresh();
      return result;
    });
  }

  validate(args: { toolCallId: string; input: unknown }): Promise<GhostbuildToolResult> {
    return this.#post('validate', args);
  }

  hasSuccessfulValidation(revision: string): Promise<boolean> {
    return this.#post<{ valid: boolean }>('validation-status', { revision }).then((result) => result.valid);
  }

  prepareDeployment(revision: string): ReturnType<BuilderWorkspaceApi['prepareDeployment']> {
    return this.#post('deployment-plan', { revision });
  }

  async createPreview(previewId: string): ReturnType<BuilderWorkspaceApi['createPreview']> {
    return this.#post('preview', { previewId });
  }

  async stopPreview(previewId: string): Promise<void> {
    await this.#post('preview/stop', { previewId });
  }

  deploy(args: Record<string, unknown> & { revision: string; deploymentId: string }) {
    return this.#post<{ workerName: string; workerVersionId: string }>('deploy', args);
  }

  async deleteProject(): Promise<void> {
    await this.#call('', { method: 'DELETE' });
    this.#state = null;
    this.#files = [];
  }

  async #executeTool<T>(toolCallId: string, toolName: string, argsJson: string, execute: () => Promise<T>) {
    const started = await this.#post<ToolOperationStartResult>('tool-operation/begin', {
      toolCallId,
      toolName,
      argsJson,
    });
    if (started.status === 'completed') {
      return started.result as T;
    }
    if (started.status === 'failed' || started.status === 'indeterminate') {
      throw new Error(started.error);
    }
    try {
      const result = await execute();
      return await this.#post<T>('tool-operation/complete', { toolCallId, result });
    } catch (error) {
      await this.#post('tool-operation/fail', {
        toolCallId,
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
      throw error;
    }
  }

  #setState(value: unknown): BuilderWorkspaceState {
    this.#state = value as BuilderWorkspaceState;
    return this.#state;
  }

  #post<T>(operation: string, body: unknown): Promise<T> {
    return this.#call(operation, { method: 'POST', body: JSON.stringify(body) });
  }

  async #call<T>(operation: string, init: RequestInit): Promise<T> {
    await this.#resolveRuntime();
    const url = `${this.#endpoint}/v1/projects/${encodeURIComponent(this.projectId)}${operation ? `/${operation}` : ''}`;
    const response = await this.request(url, {
      ...init,
      headers: {
        authorization: `Bearer ${this.#secret}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      signal: AbortSignal.timeout(5 * 60_000),
    });
    if (response.status === 204) {
      return undefined as T;
    }
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
      throw new Error('The user-owned workspace runtime response is too large.');
    }
    const payload = text ? (JSON.parse(text) as { error?: string }) : null;
    if (!response.ok) {
      throw new Error(payload?.error || `User-owned workspace operation failed (${response.status}).`);
    }
    return payload as T;
  }

  async #readStream(path: string): Promise<ReadableStream<Uint8Array>> {
    await this.#resolveRuntime();
    const url = `${this.#endpoint}/v1/projects/${encodeURIComponent(this.projectId)}/read-file-stream`;
    const response = await this.request(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.#secret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ path }),
      signal: AbortSignal.timeout(5 * 60_000),
    });
    if (!response.ok || !response.body) {
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(payload?.error || `User-owned workspace file read failed (${response.status}).`);
    }
    return response.body;
  }

  async #resolveRuntime(): Promise<void> {
    if (this.#endpoint && this.#secret) {
      return;
    }
    const userId = this.getUserId();
    if (!userId) {
      throw new Error('Agent authentication is required.');
    }
    const runtime = this.env as Env & {
      GHOSTBUILD_USER_RUNTIME?: string;
      GHOSTBUILD_USER_RUNTIME_ENDPOINT?: string;
      CONTROL_PLANE_SECRET?: string;
    };
    if (
      runtime.GHOSTBUILD_USER_RUNTIME !== '1' ||
      !runtime.GHOSTBUILD_USER_RUNTIME_ENDPOINT ||
      !runtime.CONTROL_PLANE_SECRET
    ) {
      throw new Error('The user-owned Cloudflare workspace runtime is not configured.');
    }
    this.#endpoint = new URL(runtime.GHOSTBUILD_USER_RUNTIME_ENDPOINT).origin;
    this.#secret = runtime.CONTROL_PLANE_SECRET;
  }
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

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
