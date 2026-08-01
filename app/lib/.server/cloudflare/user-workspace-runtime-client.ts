import type { GhostbuildToolResult } from 'ghostbuild-agent/tool-result';
import { BuilderWorkspaceConflictError } from '~/agents/builder-workspace';
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
import { findUserWorkspaceRuntime } from './user-workspace-runtime-repository';
import { deriveUserWorkspaceRuntimeSecret } from './user-workspace-runtime-secret';

const MAX_RESPONSE_BYTES = 36 * 1024 * 1024;
const MAX_TOOL_RESULT_BYTES = 256 * 1024;

type ToolResultRow = {
  tool_name: string;
  args_sha256: string;
  result_json: string;
};

export class UserWorkspaceRuntimeClient implements BuilderWorkspaceApi {
  readonly #inFlight = new Map<string, { toolName: string; argsJson: string; promise: Promise<unknown> }>();
  #state: BuilderWorkspaceState | null = null;
  #files: BuilderWorkspaceFileMetadata[] = [];
  #endpoint: string | null = null;
  #secret: string | null = null;

  constructor(
    private readonly env: Env,
    private readonly storage: DurableObjectStorage,
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

  async commitTextTool<T>(args: {
    toolCallId: unknown;
    toolName: 'edit' | 'writeFile';
    toolArgs: unknown;
    path: unknown;
    content: string;
    expectedFileSha256?: string | null;
    result: (context: { path: string; bytes: number; changed: boolean; workspaceRevision: number }) => T;
  }): Promise<T> {
    return this.executeToolOnce(args.toolCallId, args.toolName, args.toolArgs, async () => {
      const starting = this.getState();
      const existing = this.#files.find((file) => file.path === args.path);
      if (args.expectedFileSha256 !== undefined && (existing?.sha256 ?? null) !== args.expectedFileSha256) {
        throw new BuilderWorkspaceConflictError(starting);
      }
      const bytes = new TextEncoder().encode(args.content).byteLength;
      const result = await this.applyClientChanges({
        baseRevision: starting.revision,
        changes: [{ kind: 'write', path: args.path, content: args.content }],
      });
      if (!result.ok) {
        throw new BuilderWorkspaceConflictError(result.state);
      }
      const changed = result.changedPaths.length > 0;
      return args.result({ path: String(args.path), bytes, changed, workspaceRevision: result.state.revision });
    });
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
    const argsSha256 = await sha256(argsJson);
    const stored = first(
      this.storage.sql.exec<ToolResultRow>(
        `SELECT tool_name, args_sha256, result_json
         FROM builder_workspace_tool_results WHERE tool_call_id = ?`,
        toolCallId,
      ),
    );
    if (stored) {
      if (stored.tool_name !== toolName || stored.args_sha256 !== argsSha256) {
        throw new Error('A workspace tool-call identifier was reused with different arguments.');
      }
      return JSON.parse(stored.result_json) as T;
    }
    const result = await execute();
    const resultJson = JSON.stringify(result);
    if (new TextEncoder().encode(resultJson).byteLength > MAX_TOOL_RESULT_BYTES) {
      throw new Error('The workspace tool result exceeded its durable result limit.');
    }
    this.storage.sql.exec(
      `INSERT INTO builder_workspace_tool_results (tool_call_id, tool_name, args_sha256, result_json)
       VALUES (?, ?, ?, ?) ON CONFLICT(tool_call_id) DO NOTHING`,
      toolCallId,
      toolName,
      argsSha256,
      resultJson,
    );
    return result;
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

  async #resolveRuntime(): Promise<void> {
    if (this.#endpoint && this.#secret) {
      return;
    }
    const userId = this.getUserId();
    if (!userId) {
      throw new Error('Agent authentication is required.');
    }
    const runtime = await findUserWorkspaceRuntime(this.env.DB, userId);
    if (!runtime || runtime.status !== 'ready') {
      throw new Error('Set up the user-owned Cloudflare workspace runtime before opening a project.');
    }
    if (!this.env.CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY) {
      throw new Error('Cloudflare credential encryption is not configured.');
    }
    this.#endpoint = runtime.endpoint;
    this.#secret = await deriveUserWorkspaceRuntimeSecret({
      encryptionKeyBase64: this.env.CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY,
      userId,
      accountId: await this.#runtimeAccountId(runtime.connectionId),
      connectionGeneration: runtime.connectionGeneration,
    });
  }

  async #runtimeAccountId(connectionId: string): Promise<string> {
    const row = await this.env.DB.prepare('SELECT account_id FROM cloudflare_connections WHERE id = ?')
      .bind(connectionId)
      .first<{ account_id: string }>();
    if (!row) {
      throw new Error('The user-owned workspace runtime connection no longer exists.');
    }
    return row.account_id;
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

function first<T>(rows: Iterable<T>): T | undefined {
  for (const row of rows) {
    return row;
  }
  return undefined;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
