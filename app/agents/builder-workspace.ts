import type { DirectoryBackup, ISandbox } from '@cloudflare/sandbox';
import { assertSafeGeneratedPnpmWorkspace } from '~/utils/generatedPnpmWorkspace';
import { assertValidGeneratedPackageJson } from '~/utils/generatedPackageManifest';
import { assertNotLocalSecretFilePath } from '~/utils/secretFiles';
import { normalizeProjectPath } from '~/lib/runtime/action-runner/project-path';
import { sandboxExec } from '~/lib/.server/cloudflare/sandbox-lifecycle';
import {
  BUILDER_WORKSPACE_MAX_FILE_BYTES,
  BUILDER_WORKSPACE_MAX_FILES,
  BUILDER_WORKSPACE_MAX_TOTAL_BYTES,
  BUILDER_WORKSPACE_SYNC_BATCH_BYTES,
  BUILDER_WORKSPACE_SYNC_BATCH_FILES,
  type BuilderWorkspaceApplyResult,
  type BuilderWorkspaceClientChange,
  type BuilderWorkspaceEncoding,
  type BuilderWorkspaceFileInput,
  type BuilderWorkspaceSeedStartResult,
  type BuilderWorkspaceState,
  type BuilderWorkspaceSyncEntry,
  type BuilderWorkspaceSyncPage,
} from './builder-workspace-types';

type WorkspaceStorage = Pick<DurableObjectStorage, 'sql' | 'transactionSync'>;
type WorkspaceSandbox = ISandbox & { destroy(): Promise<void> };
export type BuilderWorkspaceBackend = {
  sandbox: WorkspaceSandbox;
  backupBucket: R2Bucket;
  localBackup: boolean;
  installDependencies(sandbox: WorkspaceSandbox, projectDir: string): Promise<void>;
  retireBackup(backup: DirectoryBackup, notBefore: number): Promise<void>;
};
type WorkspaceMetaRow = {
  initialized: number;
  revision: number;
  reset_revision: number;
  file_count: number;
  total_bytes: number;
  backup_json: string | null;
  sandbox_id: string | null;
  seed_id: string | null;
  seed_started_at: number | null;
};

type WorkspaceFileRow = {
  path: string;
  encoding: BuilderWorkspaceEncoding;
  size: number;
  sha256: string;
  revision: number;
};

type WorkspaceChangeRow = {
  path: string;
  kind: 'write' | 'delete';
  revision: number;
};

type WorkspaceToolResultRow = {
  tool_name: string;
  args_sha256: string;
  result_json: string;
};

type PreparedFile = WorkspaceFileRow & {
  content: string;
  bytes: Uint8Array;
};

type ToolExecutionIdentity = {
  toolCallId: string;
  argsSha256: string;
};

const WORKSPACE_META_ID = 1;
const SEED_STALE_MS = 10 * 60 * 1000;
const SYNC_PAGE_QUERY_LIMIT = 200;
const SYNC_PAGE_CHARACTER_LIMIT = 4 * 1024 * 1024;
const MAX_TOOL_RESULT_BYTES = 2 * 1024 * 1024;
const PROJECT_DIR = '/workspace/project';
const RESTORE_MARKER = '/tmp/ghostbuild-project-backup';
const BACKUP_TTL_SECONDS = 10 * 365 * 24 * 60 * 60;
const SUPERSEDED_BACKUP_GRACE_MS = 60 * 60 * 1000;

export class BuilderWorkspaceConflictError extends Error {
  constructor(readonly state: BuilderWorkspaceState) {
    super(`The project workspace advanced to revision ${state.revision}.`);
    this.name = 'BuilderWorkspaceConflictError';
  }
}

/**
 * Authoritative workspace state for the user-owned WorkspaceSandbox Durable
 * Object. SQLite contains only its manifest/revision protocol; file bytes live
 * exclusively in the current Sandbox DirectoryBackup in the user's R2 bucket.
 */
export class BuilderWorkspaceRepository {
  readonly #inFlightTools = new Map<string, { toolName: string; argsJson: string; promise: Promise<unknown> }>();
  #operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: WorkspaceStorage,
    private readonly backend: BuilderWorkspaceBackend,
    private readonly durableObjectId: string,
  ) {}

  getState(): BuilderWorkspaceState {
    return stateFromMeta(this.#meta());
  }

  async beginSeed(seedIdValue: unknown): Promise<BuilderWorkspaceSeedStartResult> {
    return this.#exclusive(() => this.#beginSeed(seedIdValue));
  }

  async #beginSeed(seedIdValue: unknown): Promise<BuilderWorkspaceSeedStartResult> {
    const seedId = requireSeedId(seedIdValue);
    const meta = this.#meta();
    if (meta.initialized === 1) {
      return { status: 'initialized', state: stateFromMeta(meta) };
    }
    const now = Date.now();
    if (meta.seed_id && meta.seed_id !== seedId && (meta.seed_started_at ?? 0) + SEED_STALE_MS > now) {
      return { status: 'seeding', state: stateFromMeta(meta) };
    }
    if (meta.seed_id !== seedId) {
      this.storage.transactionSync(() => {
        this.storage.sql.exec('DELETE FROM builder_workspace_seed_files');
        this.storage.sql.exec(
          `UPDATE builder_workspace_meta
           SET seed_id = ?, seed_started_at = ?, updated_at = datetime('now')
           WHERE id = ?`,
          seedId,
          now,
          WORKSPACE_META_ID,
        );
      });
      const sandbox = this.#sandbox();
      await sandbox.killAllProcesses();
      await requireSandboxSuccess(
        await sandboxExec(sandbox, `rm -rf ${PROJECT_DIR} && mkdir -p ${PROJECT_DIR}`, { timeout: 30_000 }),
      );
    }
    return { status: 'started', seedId, state: this.getState() };
  }

  async appendSeed(seedIdValue: unknown, entriesValue: unknown): Promise<BuilderWorkspaceState> {
    return this.#exclusive(() => this.#appendSeed(seedIdValue, entriesValue));
  }

  async #appendSeed(seedIdValue: unknown, entriesValue: unknown): Promise<BuilderWorkspaceState> {
    const seedId = requireSeedId(seedIdValue);
    const entries = requireFileInputs(entriesValue);
    assertSyncBatch(entries);
    const meta = this.#meta();
    if (meta.initialized === 1) {
      return stateFromMeta(meta);
    }
    if (meta.seed_id !== seedId) {
      throw new Error('The project workspace initialization lease is no longer active.');
    }
    const prepared = await Promise.all(entries.map((entry) => this.#prepareFile(entry)));
    const sandbox = this.#sandbox();
    for (const file of prepared) {
      await this.#writeSandboxFile(sandbox, file);
    }
    this.storage.transactionSync(() => {
      const currentMeta = this.#meta();
      if (currentMeta.initialized === 1 || currentMeta.seed_id !== seedId) {
        throw new Error('The project workspace initialization lease changed before this batch was committed.');
      }
      for (const file of prepared) {
        this.storage.sql.exec(
          `INSERT INTO builder_workspace_seed_files (seed_id, path, encoding, size, sha256)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(seed_id, path) DO UPDATE SET
             encoding = excluded.encoding, size = excluded.size, sha256 = excluded.sha256`,
          seedId,
          file.path,
          file.encoding,
          file.size,
          file.sha256,
        );
      }
      this.storage.sql.exec(
        `UPDATE builder_workspace_meta SET seed_started_at = ?, updated_at = datetime('now') WHERE id = ?`,
        Date.now(),
        WORKSPACE_META_ID,
      );
    });
    return this.getState();
  }

  async commitSeed(seedIdValue: unknown, expectedValue: unknown): Promise<BuilderWorkspaceState> {
    return this.#exclusive(() => this.#commitSeed(seedIdValue, expectedValue));
  }

  async #commitSeed(seedIdValue: unknown, expectedValue: unknown): Promise<BuilderWorkspaceState> {
    const seedId = requireSeedId(seedIdValue);
    const expected = requireSeedExpectation(expectedValue);
    const meta = this.#meta();
    if (meta.initialized === 1) {
      return stateFromMeta(meta);
    }
    if (meta.seed_id !== seedId) {
      throw new Error('The project workspace initialization lease is no longer active.');
    }
    const staged = this.#seedSummary(seedId);
    if (staged.file_count !== expected.fileCount || staged.total_bytes !== expected.totalBytes) {
      throw new Error(
        `Project workspace initialization is incomplete: received ${staged.file_count} files and ${staged.total_bytes} bytes.`,
      );
    }
    assertWorkspaceTotals(staged.file_count, staged.total_bytes);
    const sandbox = this.#sandbox();
    const backup = await this.#createBackup(sandbox, 1);
    this.storage.transactionSync(() => {
      const current = this.#meta();
      if (current.initialized === 1 || current.seed_id !== seedId) {
        throw new Error('The project workspace initialization lease is no longer active.');
      }
      this.storage.sql.exec('DELETE FROM builder_workspace_files');
      this.storage.sql.exec(
        `INSERT INTO builder_workspace_files (path, encoding, size, sha256, revision)
         SELECT path, encoding, size, sha256, 1 FROM builder_workspace_seed_files WHERE seed_id = ?`,
        seedId,
      );
      this.storage.sql.exec('DELETE FROM builder_workspace_seed_files WHERE seed_id = ?', seedId);
      this.storage.sql.exec('DELETE FROM builder_workspace_changes');
      this.storage.sql.exec(
        `UPDATE builder_workspace_meta
         SET initialized = 1,
             revision = 1,
             reset_revision = 1,
             file_count = ?,
             total_bytes = ?,
             backup_json = ?,
             sandbox_id = ?,
             seed_id = NULL,
             seed_started_at = NULL,
             updated_at = datetime('now')
         WHERE id = ?`,
        staged.file_count,
        staged.total_bytes,
        JSON.stringify(backup),
        this.#sandboxId(),
        WORKSPACE_META_ID,
      );
    });
    await this.#writeRestoreMarker(sandbox, backup.id);
    return this.getState();
  }

  async abortSeed(seedIdValue: unknown): Promise<BuilderWorkspaceState> {
    return this.#exclusive(() => this.#abortSeed(seedIdValue));
  }

  async #abortSeed(seedIdValue: unknown): Promise<BuilderWorkspaceState> {
    const seedId = requireSeedId(seedIdValue);
    this.storage.transactionSync(() => {
      const meta = this.#meta();
      if (meta.seed_id !== seedId || meta.initialized === 1) {
        return;
      }
      this.storage.sql.exec('DELETE FROM builder_workspace_seed_files WHERE seed_id = ?', seedId);
      this.storage.sql.exec(
        `UPDATE builder_workspace_meta
         SET seed_id = NULL, seed_started_at = NULL, updated_at = datetime('now')
         WHERE id = ?`,
        WORKSPACE_META_ID,
      );
    });
    const sandbox = this.#sandbox();
    await sandbox.killAllProcesses();
    await requireSandboxSuccess(await sandboxExec(sandbox, `rm -rf ${PROJECT_DIR}`, { timeout: 30_000 }));
    return this.getState();
  }

  async applyClientChanges(value: unknown): Promise<BuilderWorkspaceApplyResult> {
    return this.#exclusive(() => this.#applyClientChanges(value));
  }

  async #applyClientChanges(value: unknown): Promise<BuilderWorkspaceApplyResult> {
    const input = requireClientChangeRequest(value);
    const preparedWrites = new Map<string, PreparedFile>();
    for (const change of input.changes) {
      if (change.kind === 'write') {
        preparedWrites.set(change.path, await this.#prepareFile(change));
      }
    }
    const meta = this.#meta();
    if (meta.initialized !== 1) {
      throw new Error('The project workspace has not been initialized.');
    }
    if (meta.revision !== input.baseRevision) {
      return this.#changesAlreadyApplied(input.changes, preparedWrites)
        ? { ok: true, state: stateFromMeta(meta), changedPaths: [] }
        : { ok: false, conflict: true, state: stateFromMeta(meta) };
    }
    const mutations = this.#effectiveMutations(input.changes, preparedWrites);
    if (mutations.length === 0) {
      return { ok: true, state: stateFromMeta(meta), changedPaths: [] };
    }
    const nextFileCount =
      meta.file_count +
      mutations.filter((mutation) => mutation.kind === 'write' && !mutation.previous).length -
      mutations.filter((mutation) => mutation.kind === 'delete').length;
    const nextTotalBytes =
      meta.total_bytes +
      mutations.reduce(
        (bytes, mutation) =>
          bytes + (mutation.kind === 'write' ? mutation.file.size : 0) - (mutation.previous?.size ?? 0),
        0,
      );
    assertWorkspaceTotals(nextFileCount, nextTotalBytes);
    const sandbox = await this.#restoredSandbox(meta);
    for (const mutation of mutations) {
      if (mutation.kind === 'delete') {
        await sandbox.deleteFile(this.#sandboxPath(mutation.path));
      } else {
        await this.#writeSandboxFile(sandbox, mutation.file);
      }
    }
    const revision = meta.revision + 1;
    const backup = await this.#createBackup(sandbox, revision);
    try {
      this.storage.transactionSync(() => {
        const current = this.#meta();
        if (current.revision !== meta.revision || current.backup_json !== meta.backup_json) {
          throw new BuilderWorkspaceConflictError(stateFromMeta(current));
        }
        for (const mutation of mutations) {
          if (mutation.kind === 'delete') {
            this.storage.sql.exec('DELETE FROM builder_workspace_files WHERE path = ?', mutation.path);
          } else {
            this.#upsertFile(mutation.file, revision);
          }
          this.storage.sql.exec(
            `INSERT INTO builder_workspace_changes (revision, path, kind) VALUES (?, ?, ?)`,
            revision,
            mutation.path,
            mutation.kind,
          );
        }
        this.#updateMetaAfterMutation(revision, nextFileCount, nextTotalBytes, backup);
      });
    } catch (error) {
      await this.#deleteBackup(backup);
      throw error;
    }
    await this.#writeRestoreMarker(sandbox, backup.id);
    await this.#retireBackup(this.#backup(meta));
    return { ok: true, state: this.getState(), changedPaths: mutations.map((mutation) => mutation.path) };
  }

  async getSyncPage(value: unknown): Promise<BuilderWorkspaceSyncPage> {
    return this.#exclusive(() => this.#getSyncPage(value));
  }

  async #getSyncPage(value: unknown): Promise<BuilderWorkspaceSyncPage> {
    const request = requireSyncPageRequest(value);
    const state = this.getState();
    if (!state.initialized || request.fromRevision === state.revision) {
      return {
        state,
        fromRevision: request.fromRevision,
        targetRevision: state.revision,
        mode: 'current',
        entries: [],
      };
    }
    if (request.targetRevision !== undefined && request.targetRevision !== state.revision) {
      return {
        state,
        fromRevision: request.fromRevision,
        targetRevision: state.revision,
        mode: 'current',
        entries: [],
        restart: true,
      };
    }
    const mode =
      request.fromRevision < state.resetRevision || request.fromRevision > state.revision ? 'snapshot' : 'delta';
    const rows =
      mode === 'snapshot' ? this.#snapshotRows(request.offset) : this.#deltaRows(request.fromRevision, request.offset);
    const entries: BuilderWorkspaceSyncEntry[] = [];
    let characters = 0;
    let consumed = 0;
    for (const row of rows) {
      if (entries.length >= SYNC_PAGE_QUERY_LIMIT) {
        break;
      }
      const entry =
        row.kind === 'delete'
          ? ({
              kind: 'delete',
              path: row.path,
              revision: row.revision,
            } as const)
          : await this.#syncWriteEntry(row.path, row.revision);
      const entryCharacters = entry.kind === 'write' ? entry.path.length + entry.content.length : entry.path.length;
      if (entries.length > 0 && characters + entryCharacters > SYNC_PAGE_CHARACTER_LIMIT) {
        break;
      }
      entries.push(entry);
      characters += entryCharacters;
      consumed += 1;
    }
    const hasMore = rows.length > consumed;
    const currentState = this.getState();
    if (currentState.revision !== state.revision) {
      return {
        state: currentState,
        fromRevision: request.fromRevision,
        targetRevision: currentState.revision,
        mode: 'current',
        entries: [],
        restart: true,
      };
    }
    return {
      state,
      fromRevision: request.fromRevision,
      targetRevision: state.revision,
      mode,
      entries,
      ...(hasMore ? { nextCursor: String(request.offset + consumed) } : {}),
    };
  }

  async readText(
    pathValue: unknown,
  ): Promise<{ path: string; content: string; size: number; sha256: string; revision: number }> {
    return this.#exclusive(() => this.#readText(pathValue));
  }

  async #readText(
    pathValue: unknown,
  ): Promise<{ path: string; content: string; size: number; sha256: string; revision: number }> {
    const path = requireWorkspacePath(pathValue);
    const row = this.#file(path);
    if (!row) {
      throw new Error(`File not found: ${path}`);
    }
    const storedContent = await this.#readStoredContent(row);
    const content = row.encoding === 'utf8' ? storedContent : decodeLegacyText(storedContent, path);
    return {
      path,
      content,
      size: row.size,
      sha256: row.sha256,
      revision: row.revision,
    };
  }

  async readFile(pathValue: unknown): Promise<{
    path: string;
    bytes: Uint8Array;
    encoding: BuilderWorkspaceEncoding;
    size: number;
    sha256: string;
    revision: number;
  }> {
    return this.#exclusive(() => this.#readFile(pathValue));
  }

  async #readFile(pathValue: unknown): Promise<{
    path: string;
    bytes: Uint8Array;
    encoding: BuilderWorkspaceEncoding;
    size: number;
    sha256: string;
    revision: number;
  }> {
    const path = requireWorkspacePath(pathValue);
    const row = this.#file(path);
    if (!row) {
      throw new Error(`File not found: ${path}`);
    }
    const content = await this.#readStoredContent(row);
    return {
      path,
      bytes: row.encoding === 'utf8' ? new TextEncoder().encode(content) : decodeBase64(content),
      encoding: row.encoding,
      size: row.size,
      sha256: row.sha256,
      revision: row.revision,
    };
  }

  listFiles(): Array<Pick<WorkspaceFileRow, 'path' | 'encoding' | 'size' | 'sha256' | 'revision'>> {
    return [
      ...this.storage.sql.exec<Pick<WorkspaceFileRow, 'path' | 'encoding' | 'size' | 'sha256' | 'revision'>>(
        `SELECT path, encoding, size, sha256, revision
         FROM builder_workspace_files
         ORDER BY path ASC`,
      ),
    ];
  }

  async executeToolOnce<T>(
    toolCallIdValue: unknown,
    toolName: string,
    args: unknown,
    execute: () => Promise<T>,
  ): Promise<T> {
    return this.#executeReplayableTool(toolCallIdValue, toolName, args, async ({ toolCallId, argsSha256 }) => {
      const result = await execute();
      const resultJson = JSON.stringify(result);
      if (textBytes(resultJson) > MAX_TOOL_RESULT_BYTES) {
        throw new Error('The workspace tool result exceeded its durable result limit.');
      }
      this.storage.sql.exec(
        `INSERT INTO builder_workspace_tool_results
           (tool_call_id, tool_name, args_sha256, result_json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(tool_call_id) DO NOTHING`,
        toolCallId,
        toolName,
        argsSha256,
        resultJson,
      );
      this.#pruneToolResults();
      return result;
    });
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
    return this.#exclusive(() => this.#commitTextTool(args));
  }

  async #commitTextTool<T>(args: {
    toolCallId: unknown;
    toolName: 'edit' | 'writeFile';
    toolArgs: unknown;
    path: unknown;
    content: string;
    expectedFileSha256?: string | null;
    result: (context: { path: string; bytes: number; changed: boolean; workspaceRevision: number }) => T;
  }): Promise<T> {
    return this.#executeReplayableTool(
      args.toolCallId,
      args.toolName,
      args.toolArgs,
      async ({ toolCallId, argsSha256 }) => {
        const file = await this.#prepareFile({
          path: requireWorkspacePath(args.path),
          content: args.content,
          encoding: 'utf8',
        });
        const meta = this.#meta();
        if (meta.initialized !== 1) {
          throw new Error('The project workspace has not been initialized.');
        }
        const previous = this.#file(file.path);
        if (args.expectedFileSha256 !== undefined && (previous?.sha256 ?? null) !== args.expectedFileSha256) {
          throw new BuilderWorkspaceConflictError(stateFromMeta(meta));
        }
        const changed = previous?.sha256 !== file.sha256 || previous?.encoding !== file.encoding;
        const revision = changed ? meta.revision + 1 : meta.revision;
        const result = args.result({ path: file.path, bytes: file.size, changed, workspaceRevision: revision });
        const resultJson = boundedToolResultJson(result);
        if (!changed) {
          this.#insertToolResult(toolCallId, args.toolName, argsSha256, resultJson);
          return result;
        }
        const nextFileCount = meta.file_count + (previous ? 0 : 1);
        const nextTotalBytes = meta.total_bytes + file.size - (previous?.size ?? 0);
        assertWorkspaceTotals(nextFileCount, nextTotalBytes);
        const sandbox = await this.#restoredSandbox(meta);
        await this.#writeSandboxFile(sandbox, file);
        const backup = await this.#createBackup(sandbox, revision);
        try {
          this.storage.transactionSync(() => {
            const replay = this.#toolResult<T>(toolCallId, args.toolName, argsSha256);
            if (replay !== undefined) {
              throw new Error('The workspace tool completed concurrently.');
            }
            const current = this.#meta();
            if (current.revision !== meta.revision || current.backup_json !== meta.backup_json) {
              throw new BuilderWorkspaceConflictError(stateFromMeta(current));
            }
            this.#upsertFile(file, revision);
            this.storage.sql.exec(
              `INSERT INTO builder_workspace_changes (revision, path, kind) VALUES (?, ?, 'write')`,
              revision,
              file.path,
            );
            this.#updateMetaAfterMutation(revision, nextFileCount, nextTotalBytes, backup);
            this.#insertToolResult(toolCallId, args.toolName, argsSha256, resultJson);
          });
        } catch (error) {
          await this.#deleteBackup(backup);
          throw error;
        }
        await this.#writeRestoreMarker(sandbox, backup.id);
        await this.#retireBackup(this.#backup(meta));
        return result;
      },
    );
  }

  async commitTextFilesTool<T>(args: {
    toolCallId: unknown;
    toolName: 'npmInstall';
    toolArgs: unknown;
    prepare: () => Promise<Array<{ path: unknown; content: string }>>;
    expectedWorkspaceRevision: number;
    result: (context: { changedPaths: string[]; workspaceRevision: number }) => T;
  }): Promise<T> {
    return this.#exclusive(() => this.#commitTextFilesTool(args));
  }

  async #commitTextFilesTool<T>(args: {
    toolCallId: unknown;
    toolName: 'npmInstall';
    toolArgs: unknown;
    prepare: () => Promise<Array<{ path: unknown; content: string }>>;
    expectedWorkspaceRevision: number;
    result: (context: { changedPaths: string[]; workspaceRevision: number }) => T;
  }): Promise<T> {
    return this.#executeReplayableTool(
      args.toolCallId,
      args.toolName,
      args.toolArgs,
      async ({ toolCallId, argsSha256 }) => {
        const files = await args.prepare();
        const prepared = await Promise.all(
          files.map((file) =>
            this.#prepareFile({
              path: requireWorkspacePath(file.path),
              content: file.content,
              encoding: 'utf8',
            }),
          ),
        );
        if (new Set(prepared.map((file) => file.path)).size !== prepared.length) {
          throw new Error('A dependency operation returned duplicate project files.');
        }
        const meta = this.#meta();
        if (meta.initialized !== 1 || meta.revision !== args.expectedWorkspaceRevision) {
          throw new BuilderWorkspaceConflictError(stateFromMeta(meta));
        }
        const mutations = prepared
          .map((file) => ({ file, previous: this.#file(file.path) }))
          .filter(({ file, previous }) => previous?.sha256 !== file.sha256 || previous?.encoding !== file.encoding);
        const revision = mutations.length > 0 ? meta.revision + 1 : meta.revision;
        const nextFileCount = meta.file_count + mutations.filter(({ previous }) => !previous).length;
        const nextTotalBytes =
          meta.total_bytes +
          mutations.reduce((total, { file, previous }) => total + file.size - (previous?.size ?? 0), 0);
        assertWorkspaceTotals(nextFileCount, nextTotalBytes);
        const result = args.result({
          changedPaths: mutations.map(({ file }) => file.path),
          workspaceRevision: revision,
        });
        const resultJson = boundedToolResultJson(result);
        if (mutations.length === 0) {
          this.#insertToolResult(toolCallId, args.toolName, argsSha256, resultJson);
          return result;
        }
        const sandbox = await this.#restoredSandbox(meta);
        for (const { file } of mutations) {
          await this.#writeSandboxFile(sandbox, file);
        }
        const backup = await this.#createBackup(sandbox, revision);
        try {
          this.storage.transactionSync(() => {
            const replay = this.#toolResult<T>(toolCallId, args.toolName, argsSha256);
            if (replay !== undefined) {
              throw new Error('The workspace tool completed concurrently.');
            }
            const current = this.#meta();
            if (current.revision !== meta.revision || current.backup_json !== meta.backup_json) {
              throw new BuilderWorkspaceConflictError(stateFromMeta(current));
            }
            for (const { file } of mutations) {
              this.#upsertFile(file, revision);
              this.storage.sql.exec(
                `INSERT INTO builder_workspace_changes (revision, path, kind) VALUES (?, ?, 'write')`,
                revision,
                file.path,
              );
            }
            this.#updateMetaAfterMutation(revision, nextFileCount, nextTotalBytes, backup);
            this.#insertToolResult(toolCallId, args.toolName, argsSha256, resultJson);
          });
        } catch (error) {
          await this.#deleteBackup(backup);
          throw error;
        }
        await this.#writeRestoreMarker(sandbox, backup.id);
        await this.#retireBackup(this.#backup(meta));
        return result;
      },
    );
  }

  recordSuccessfulValidation(args: { revision: string; workspaceRevision: number }): void {
    if (!/^[a-f0-9]{64}$/.test(args.revision)) {
      throw new Error('The validated project revision is invalid.');
    }
    this.storage.transactionSync(() => {
      const meta = this.#meta();
      if (meta.initialized !== 1 || meta.revision !== args.workspaceRevision) {
        throw new BuilderWorkspaceConflictError(stateFromMeta(meta));
      }
      this.storage.sql.exec(
        `INSERT INTO builder_workspace_validations (revision, workspace_revision)
         VALUES (?, ?)
         ON CONFLICT(revision) DO UPDATE SET
           workspace_revision = excluded.workspace_revision,
           created_at = datetime('now')`,
        args.revision,
        args.workspaceRevision,
      );
      this.storage.sql.exec(
        `DELETE FROM builder_workspace_validations
         WHERE revision IN (
           SELECT revision
           FROM builder_workspace_validations
           ORDER BY created_at DESC, rowid DESC
           LIMIT -1 OFFSET 100
         )`,
      );
    });
  }

  hasSuccessfulValidation(revision: string): boolean {
    return Boolean(
      first(
        this.storage.sql.exec<{ found: number }>(
          `SELECT 1 AS found
           FROM builder_workspace_validations
           WHERE revision = ?
           LIMIT 1`,
          revision,
        ),
      ),
    );
  }

  async #executeReplayableTool<T>(
    toolCallIdValue: unknown,
    toolName: string,
    toolArgs: unknown,
    execute: (identity: ToolExecutionIdentity) => Promise<T>,
  ): Promise<T> {
    const toolCallId = requireToolCallId(toolCallIdValue);
    const argsJson = stableJson(toolArgs);
    const existing = this.#inFlightTools.get(toolCallId);
    if (existing) {
      assertMatchingInFlightTool(existing, toolName, argsJson);
      return (await existing.promise) as T;
    }
    const execution = (async () => {
      const argsSha256 = await sha256Text(argsJson);
      const stored = this.#toolResult<T>(toolCallId, toolName, argsSha256);
      return stored === undefined ? execute({ toolCallId, argsSha256 }) : stored;
    })();
    this.#inFlightTools.set(toolCallId, { toolName, argsJson, promise: execution });
    try {
      return await execution;
    } finally {
      this.#inFlightTools.delete(toolCallId);
    }
  }

  async deleteExternalObjects(): Promise<void> {
    const backup = this.#backup(this.#meta(), false);
    if (backup) {
      await this.#deleteBackup(backup, true);
    }
    await this.#sandbox().destroy();
  }

  getBackupHandle(): DirectoryBackup {
    return this.#backup(this.#meta());
  }

  async ensureRuntimeReady(): Promise<DirectoryBackup> {
    return this.#exclusive(() => this.#ensureRuntimeReady());
  }

  async #ensureRuntimeReady(): Promise<DirectoryBackup> {
    const meta = this.#meta();
    if (meta.initialized !== 1) {
      throw new Error('The project workspace has not been initialized.');
    }
    const sandbox = await this.#restoredSandbox(meta);
    const ready = await sandboxExec(
      sandbox,
      `test -f node_modules/.ghostbuild-lock-sha && ` +
        `test "$(cat node_modules/.ghostbuild-lock-sha)" = "$(sha256sum pnpm-lock.yaml | cut -d ' ' -f1)"`,
      { cwd: PROJECT_DIR, timeout: 30_000 },
    );
    if (ready.success) {
      return this.#backup(meta);
    }
    const pnpm = await sandboxExec(sandbox, 'command -v pnpm', { timeout: 30_000 });
    requireSandboxSuccess(pnpm);
    await this.backend.installDependencies(sandbox, PROJECT_DIR);
    requireSandboxSuccess(
      await sandboxExec(sandbox, `sha256sum pnpm-lock.yaml | cut -d ' ' -f1 > node_modules/.ghostbuild-lock-sha`, {
        cwd: PROJECT_DIR,
        timeout: 30_000,
      }),
    );
    const backup = await this.#createBackup(sandbox, meta.revision);
    try {
      this.storage.transactionSync(() => {
        const current = this.#meta();
        if (current.revision !== meta.revision || current.backup_json !== meta.backup_json) {
          throw new BuilderWorkspaceConflictError(stateFromMeta(current));
        }
        this.storage.sql.exec(
          `UPDATE builder_workspace_meta SET backup_json = ?, updated_at = datetime('now') WHERE id = ?`,
          JSON.stringify(backup),
          WORKSPACE_META_ID,
        );
      });
    } catch (error) {
      await this.#deleteBackup(backup);
      throw error;
    }
    await this.#writeRestoreMarker(sandbox, backup.id);
    await this.#retireBackup(this.#backup(meta));
    return backup;
  }

  #meta(): WorkspaceMetaRow {
    const row = first(
      this.storage.sql.exec<WorkspaceMetaRow>(
        `SELECT initialized, revision, reset_revision, file_count, total_bytes, backup_json, sandbox_id,
                seed_id, seed_started_at
         FROM builder_workspace_meta
         WHERE id = ?`,
        WORKSPACE_META_ID,
      ),
    );
    if (!row) {
      throw new Error('Builder workspace metadata is missing.');
    }
    return row;
  }

  #file(path: string): WorkspaceFileRow | undefined {
    return first(
      this.storage.sql.exec<WorkspaceFileRow>(
        `SELECT path, encoding, size, sha256, revision
         FROM builder_workspace_files
         WHERE path = ?`,
        path,
      ),
    );
  }

  #seedSummary(seedId: string): { file_count: number; total_bytes: number } {
    return (
      first(
        this.storage.sql.exec<{ file_count: number; total_bytes: number }>(
          `SELECT COUNT(*) AS file_count, COALESCE(SUM(size), 0) AS total_bytes
           FROM builder_workspace_seed_files
           WHERE seed_id = ?`,
          seedId,
        ),
      ) ?? { file_count: 0, total_bytes: 0 }
    );
  }

  #snapshotRows(offset: number): WorkspaceChangeRow[] {
    return [
      ...this.storage.sql.exec<WorkspaceChangeRow>(
        `SELECT path, 'write' AS kind, revision
         FROM builder_workspace_files
         ORDER BY path ASC
         LIMIT ? OFFSET ?`,
        SYNC_PAGE_QUERY_LIMIT + 1,
        offset,
      ),
    ];
  }

  #deltaRows(fromRevision: number, offset: number): WorkspaceChangeRow[] {
    return [
      ...this.storage.sql.exec<WorkspaceChangeRow>(
        `SELECT latest.path, changes.kind, latest.revision
         FROM (
           SELECT path, MAX(revision) AS revision
           FROM builder_workspace_changes
           WHERE revision > ?
           GROUP BY path
         ) AS latest
         INNER JOIN builder_workspace_changes AS changes
           ON changes.path = latest.path AND changes.revision = latest.revision
         ORDER BY latest.path ASC
         LIMIT ? OFFSET ?`,
        fromRevision,
        SYNC_PAGE_QUERY_LIMIT + 1,
        offset,
      ),
    ];
  }

  async #syncWriteEntry(path: string, revision: number): Promise<BuilderWorkspaceSyncEntry> {
    const file = this.#file(path);
    if (!file) {
      return { kind: 'delete', path, revision };
    }
    return {
      kind: 'write',
      path,
      content: await this.#readStoredContent(file),
      encoding: file.encoding,
      size: file.size,
      sha256: file.sha256,
      revision,
    };
  }

  async #prepareFile(input: BuilderWorkspaceFileInput): Promise<PreparedFile> {
    const path = requireWorkspacePath(input.path);
    const encoding = input.encoding ?? 'utf8';
    if (encoding !== 'utf8' && encoding !== 'base64') {
      throw new Error(`Unsupported workspace encoding for ${path}.`);
    }
    const bytes = encoding === 'utf8' ? new TextEncoder().encode(input.content) : decodeBase64(input.content);
    if (bytes.byteLength > BUILDER_WORKSPACE_MAX_FILE_BYTES) {
      throw new Error(`Project file exceeds the ${BUILDER_WORKSPACE_MAX_FILE_BYTES} byte limit: ${path}`);
    }
    if (encoding === 'utf8') {
      assertSafeWorkspaceText(path, input.content);
    }
    const sha256 = await sha256Bytes(bytes);
    return {
      path,
      content: input.content,
      encoding,
      size: bytes.byteLength,
      sha256,
      revision: 0,
      bytes,
    };
  }

  async #readStoredContent(row: WorkspaceFileRow): Promise<string> {
    const sandbox = await this.#restoredSandbox(this.#meta());
    const result = await sandbox.readFile(this.#sandboxPath(row.path), {
      encoding: row.encoding === 'utf8' ? 'utf8' : 'base64',
    });
    if (!result.success) {
      throw new Error(`Project file is missing from the current backup: ${row.path}`);
    }
    const content = result.content;
    const bytes = row.encoding === 'utf8' ? new TextEncoder().encode(content) : decodeBase64(content);
    if (bytes.byteLength !== row.size || (await sha256Bytes(bytes)) !== row.sha256) {
      throw new Error(`Project file failed backup integrity verification: ${row.path}`);
    }
    return content;
  }

  #effectiveMutations(
    changes: BuilderWorkspaceClientChange[],
    preparedWrites: Map<string, PreparedFile>,
  ): Array<
    | { kind: 'write'; path: string; file: PreparedFile; previous?: WorkspaceFileRow }
    | { kind: 'delete'; path: string; file?: undefined; previous: WorkspaceFileRow }
  > {
    const mutations: Array<
      | { kind: 'write'; path: string; file: PreparedFile; previous?: WorkspaceFileRow }
      | { kind: 'delete'; path: string; file?: undefined; previous: WorkspaceFileRow }
    > = [];
    for (const change of changes) {
      const path = requireWorkspacePath(change.path);
      const previous = this.#file(path);
      if (change.kind === 'delete') {
        if (previous) {
          mutations.push({ kind: 'delete', path, previous });
        }
        continue;
      }
      const file = preparedWrites.get(change.path) ?? preparedWrites.get(path);
      if (!file) {
        throw new Error(`Prepared project file is missing: ${path}`);
      }
      if (previous?.sha256 === file.sha256 && previous.encoding === file.encoding) {
        continue;
      }
      mutations.push({ kind: 'write', path, file, ...(previous ? { previous } : {}) });
    }
    return mutations;
  }

  #changesAlreadyApplied(changes: BuilderWorkspaceClientChange[], preparedWrites: Map<string, PreparedFile>): boolean {
    return changes.every((change) => {
      const path = requireWorkspacePath(change.path);
      const current = this.#file(path);
      if (change.kind === 'delete') {
        return current === undefined;
      }
      const prepared = preparedWrites.get(change.path) ?? preparedWrites.get(path);
      return Boolean(prepared && current?.sha256 === prepared.sha256 && current.encoding === prepared.encoding);
    });
  }

  #upsertFile(file: PreparedFile, revision: number): void {
    this.storage.sql.exec(
      `INSERT INTO builder_workspace_files
         (path, encoding, size, sha256, revision, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(path) DO UPDATE SET
         encoding = excluded.encoding,
         size = excluded.size,
         sha256 = excluded.sha256,
         revision = excluded.revision,
         updated_at = excluded.updated_at`,
      file.path,
      file.encoding,
      file.size,
      file.sha256,
      revision,
    );
  }

  #updateMetaAfterMutation(revision: number, fileCount: number, totalBytes: number, backup: DirectoryBackup): void {
    const retainedFromRevision = Math.max(0, revision - 2_000);
    this.storage.sql.exec(
      `UPDATE builder_workspace_meta
       SET revision = ?,
           reset_revision = MAX(reset_revision, ?),
           file_count = ?,
           total_bytes = ?,
           backup_json = ?,
           sandbox_id = ?,
           updated_at = datetime('now')
       WHERE id = ?`,
      revision,
      retainedFromRevision,
      fileCount,
      totalBytes,
      JSON.stringify(backup),
      this.#sandboxId(),
      WORKSPACE_META_ID,
    );
    this.storage.sql.exec(
      `DELETE FROM builder_workspace_changes
       WHERE revision < ?`,
      retainedFromRevision,
    );
  }

  #toolResult<T>(toolCallId: string, toolName: string, argsSha256: string): T | undefined {
    const stored = first(
      this.storage.sql.exec<WorkspaceToolResultRow>(
        `SELECT tool_name, args_sha256, result_json
         FROM builder_workspace_tool_results
         WHERE tool_call_id = ?`,
        toolCallId,
      ),
    );
    if (!stored) {
      return undefined;
    }
    if (stored.tool_name !== toolName || stored.args_sha256 !== argsSha256) {
      throw new Error('A workspace tool-call identifier was reused with different arguments.');
    }
    return JSON.parse(stored.result_json) as T;
  }

  #pruneToolResults(): void {
    this.storage.sql.exec(
      `DELETE FROM builder_workspace_tool_results
       WHERE tool_name NOT IN ('edit', 'writeFile')
         AND tool_call_id IN (
         SELECT tool_call_id
         FROM builder_workspace_tool_results
         WHERE tool_name NOT IN ('edit', 'writeFile')
         ORDER BY rowid DESC
         LIMIT -1 OFFSET 1000
       )`,
    );
  }

  #insertToolResult(toolCallId: string, toolName: string, argsSha256: string, resultJson: string): void {
    this.storage.sql.exec(
      `INSERT INTO builder_workspace_tool_results (tool_call_id, tool_name, args_sha256, result_json)
       VALUES (?, ?, ?, ?)`,
      toolCallId,
      toolName,
      argsSha256,
      resultJson,
    );
    this.#pruneToolResults();
  }

  #sandboxId(): string {
    return `workspace-${this.durableObjectId.replaceAll(/[^a-zA-Z0-9]/g, '').slice(-48)}`;
  }

  #sandbox(): WorkspaceSandbox {
    return this.backend.sandbox;
  }

  #backup(meta: WorkspaceMetaRow, required?: true): DirectoryBackup;
  #backup(meta: WorkspaceMetaRow, required: false): DirectoryBackup | null;
  #backup(meta: WorkspaceMetaRow, required = true): DirectoryBackup | null {
    if (!meta.backup_json) {
      if (required) {
        throw new Error('The project workspace backup is missing.');
      }
      return null;
    }
    const value = JSON.parse(meta.backup_json) as Partial<DirectoryBackup>;
    if (typeof value.id !== 'string' || value.dir !== PROJECT_DIR) {
      throw new Error('The project workspace backup handle is invalid.');
    }
    return { id: value.id, dir: value.dir, ...(value.localBucket ? { localBucket: true } : {}) };
  }

  async #restoredSandbox(meta: WorkspaceMetaRow): Promise<WorkspaceSandbox> {
    const backup = this.#backup(meta);
    const sandbox = this.#sandbox();
    const marker = await sandboxExec(
      sandbox,
      `test "$(cat ${RESTORE_MARKER} 2>/dev/null)" = ${shellQuote(backup.id)}`,
      {
        timeout: 30_000,
      },
    );
    if (!marker.success) {
      await sandbox.killAllProcesses();
      const restored = await sandbox.restoreBackup(backup);
      if (!restored.success) {
        throw new Error('The project workspace backup could not be restored.');
      }
      await this.#writeRestoreMarker(sandbox, backup.id);
    }
    return sandbox;
  }

  async #createBackup(sandbox: WorkspaceSandbox, revision: number): Promise<DirectoryBackup> {
    return sandbox.createBackup({
      dir: PROJECT_DIR,
      name: `ghostbuild-${this.durableObjectId.slice(-24)}-r${revision}`,
      ttl: BACKUP_TTL_SECONDS,
      localBucket: this.backend.localBackup,
      multipart: true,
    });
  }

  async #deleteBackup(backup: DirectoryBackup, strict = false): Promise<void> {
    try {
      await this.backend.backupBucket.delete([`backups/${backup.id}/data.sqsh`, `backups/${backup.id}/meta.json`]);
    } catch (error) {
      if (strict) {
        throw error;
      }
      console.warn('Unable to remove a superseded project backup', error);
    }
  }

  async #retireBackup(backup: DirectoryBackup): Promise<void> {
    const notBefore = Date.now() + SUPERSEDED_BACKUP_GRACE_MS;
    try {
      await this.backend.retireBackup(backup, notBefore);
    } catch (error) {
      console.warn('Unable to schedule superseded project backup cleanup', error);
    }
  }

  async #writeSandboxFile(sandbox: WorkspaceSandbox, file: PreparedFile): Promise<void> {
    const path = this.#sandboxPath(file.path);
    await sandbox.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    const content = file.encoding === 'utf8' ? file.content : new Blob([file.bytes.slice().buffer]).stream();
    const written = await sandbox.writeFile(path, content);
    if (!written.success) {
      throw new Error(`Unable to write project file: ${file.path}`);
    }
  }

  #sandboxPath(path: string): string {
    const normalized = normalizeProjectPath(path);
    return `${PROJECT_DIR}/${normalized.relativePath}`;
  }

  async #writeRestoreMarker(sandbox: WorkspaceSandbox, backupId: string): Promise<void> {
    const result = await sandbox.writeFile(RESTORE_MARKER, backupId);
    if (!result.success) {
      throw new Error('Unable to mark the restored project backup.');
    }
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const predecessor = this.#operationTail;
    let release!: () => void;
    this.#operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function boundedToolResultJson(result: unknown): string {
  const json = JSON.stringify(result);
  if (textBytes(json) > MAX_TOOL_RESULT_BYTES) {
    throw new Error('The workspace tool result exceeded its durable result limit.');
  }
  return json;
}

function requireSandboxSuccess(result: { success: boolean; stderr: string; stdout: string }): void {
  if (!result.success) {
    throw new Error(`${result.stderr}\n${result.stdout}`.trim() || 'The project sandbox command failed.');
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function stateFromMeta(meta: WorkspaceMetaRow): BuilderWorkspaceState {
  return {
    initialized: meta.initialized === 1,
    revision: meta.revision,
    resetRevision: meta.reset_revision,
    fileCount: meta.file_count,
    totalBytes: meta.total_bytes,
    seeding: meta.seed_id !== null,
  };
}

function requireSeedId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(value)) {
    throw new Error('Invalid project workspace initialization identifier.');
  }
  return value;
}

function requireSeedExpectation(value: unknown): { fileCount: number; totalBytes: number } {
  const candidate = isRecord(value) ? value : {};
  if (
    !Number.isSafeInteger(candidate.fileCount) ||
    (candidate.fileCount as number) < 0 ||
    !Number.isSafeInteger(candidate.totalBytes) ||
    (candidate.totalBytes as number) < 0
  ) {
    throw new Error('Invalid project workspace initialization totals.');
  }
  const expectation = {
    fileCount: candidate.fileCount as number,
    totalBytes: candidate.totalBytes as number,
  };
  assertWorkspaceTotals(expectation.fileCount, expectation.totalBytes);
  return expectation;
}

function requireFileInputs(value: unknown): BuilderWorkspaceFileInput[] {
  if (!Array.isArray(value)) {
    throw new Error('Project workspace files must be an array.');
  }
  return value.map((candidate) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.path !== 'string' ||
      typeof candidate.content !== 'string' ||
      (candidate.encoding !== undefined && candidate.encoding !== 'utf8' && candidate.encoding !== 'base64')
    ) {
      throw new Error('Invalid project workspace file.');
    }
    return {
      path: requireWorkspacePath(candidate.path),
      content: candidate.content,
      ...(candidate.encoding ? { encoding: candidate.encoding } : {}),
    };
  });
}

function requireClientChangeRequest(value: unknown): {
  baseRevision: number;
  changes: BuilderWorkspaceClientChange[];
} {
  if (!isRecord(value) || !Number.isSafeInteger(value.baseRevision) || (value.baseRevision as number) < 0) {
    throw new Error('Invalid project workspace base revision.');
  }
  if (!Array.isArray(value.changes) || value.changes.length > BUILDER_WORKSPACE_SYNC_BATCH_FILES) {
    throw new Error('Invalid project workspace change batch.');
  }
  const seen = new Set<string>();
  let characters = 0;
  const changes = value.changes.map((candidate): BuilderWorkspaceClientChange => {
    if (!isRecord(candidate) || (candidate.kind !== 'write' && candidate.kind !== 'delete')) {
      throw new Error('Invalid project workspace change.');
    }
    const path = requireWorkspacePath(candidate.path);
    if (seen.has(path)) {
      throw new Error(`Project workspace change batch contains a duplicate path: ${path}`);
    }
    seen.add(path);
    characters += path.length;
    if (candidate.kind === 'delete') {
      return { kind: 'delete', path };
    }
    if (
      typeof candidate.content !== 'string' ||
      (candidate.encoding !== undefined && candidate.encoding !== 'utf8' && candidate.encoding !== 'base64')
    ) {
      throw new Error(`Invalid project workspace write: ${path}`);
    }
    characters += candidate.content.length;
    return {
      kind: 'write',
      path,
      content: candidate.content,
      ...(candidate.encoding ? { encoding: candidate.encoding } : {}),
    };
  });
  if (characters > BUILDER_WORKSPACE_SYNC_BATCH_BYTES * 6) {
    throw new Error('Project workspace change batch is too large.');
  }
  return { baseRevision: value.baseRevision as number, changes };
}

function requireSyncPageRequest(value: unknown): {
  fromRevision: number;
  targetRevision?: number;
  offset: number;
} {
  const candidate = isRecord(value) ? value : {};
  if (!Number.isSafeInteger(candidate.fromRevision) || (candidate.fromRevision as number) < 0) {
    throw new Error('Invalid project workspace sync revision.');
  }
  const targetRevision =
    candidate.targetRevision === undefined
      ? undefined
      : Number.isSafeInteger(candidate.targetRevision) && (candidate.targetRevision as number) >= 0
        ? (candidate.targetRevision as number)
        : null;
  if (targetRevision === null) {
    throw new Error('Invalid project workspace target revision.');
  }
  const offset =
    candidate.cursor === undefined
      ? 0
      : typeof candidate.cursor === 'string' && /^\d{1,8}$/.test(candidate.cursor)
        ? Number(candidate.cursor)
        : -1;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error('Invalid project workspace sync cursor.');
  }
  return {
    fromRevision: candidate.fromRevision as number,
    ...(targetRevision !== undefined ? { targetRevision } : {}),
    offset,
  };
}

function requireWorkspacePath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_024 || value.includes('\0')) {
    throw new Error('Invalid project workspace path.');
  }
  const { absolutePath, relativePath } = normalizeProjectPath(value);
  if (relativePath === '.') {
    throw new Error('A project workspace file path is required.');
  }
  assertNotLocalSecretFilePath(relativePath);
  if (/(^|\/)\.ghost(?:[-.]|$)/.test(relativePath)) {
    throw new Error(`Ghostbuild internal files cannot be written: ${absolutePath}`);
  }
  return absolutePath;
}

function assertSafeWorkspaceText(path: string, content: string): void {
  const relativePath = normalizeProjectPath(path).relativePath;
  assertNotLocalSecretFilePath(relativePath);
  assertValidGeneratedPackageJson(relativePath, content);
  assertSafeGeneratedPnpmWorkspace(relativePath, content);
}

function assertSyncBatch(entries: BuilderWorkspaceFileInput[]): void {
  if (entries.length === 0 || entries.length > BUILDER_WORKSPACE_SYNC_BATCH_FILES) {
    throw new Error('Project workspace initialization batch has an invalid file count.');
  }
  const characters = entries.reduce((total, entry) => total + entry.path.length + entry.content.length, 0);
  if (characters > BUILDER_WORKSPACE_SYNC_BATCH_BYTES * 6) {
    throw new Error('Project workspace initialization batch is too large.');
  }
}

function assertWorkspaceTotals(fileCount: number, totalBytes: number): void {
  if (fileCount > BUILDER_WORKSPACE_MAX_FILES) {
    throw new Error(`Project workspace exceeds the ${BUILDER_WORKSPACE_MAX_FILES} file limit.`);
  }
  if (totalBytes > BUILDER_WORKSPACE_MAX_TOTAL_BYTES) {
    throw new Error(`Project workspace exceeds the ${BUILDER_WORKSPACE_MAX_TOTAL_BYTES} byte limit.`);
  }
}

function requireToolCallId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new Error('Invalid workspace tool-call identifier.');
  }
  return value;
}

function first<T>(rows: Iterable<T>): T | undefined {
  for (const row of rows) {
    return row;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeBase64(value: string): Uint8Array {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    throw new Error('Invalid base64 project file content.');
  }
}

function decodeLegacyText(value: string, path: string): string {
  const bytes = decodeBase64(value);
  if (bytes.some((byte) => byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d)) {
    throw new Error(`Cannot read binary file as text: ${path}`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`Cannot read binary file as text: ${path}`);
  }
}

async function sha256Text(value: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(value));
}

async function sha256Bytes(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', value as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function textBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function assertMatchingInFlightTool(
  inFlight: { toolName: string; argsJson: string },
  toolName: string,
  argsJson: string,
): void {
  if (inFlight.toolName !== toolName || inFlight.argsJson !== argsJson) {
    throw new Error('A workspace tool-call identifier was reused with different arguments.');
  }
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])]),
  );
}
