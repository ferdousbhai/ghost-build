import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BuilderWorkspaceRepository } from './builder-workspace';
import { initializeWorkspaceRuntimeSchema } from './builder-workspace-runtime-schema';

const sandboxMocks = vi.hoisted(() => ({ getSandbox: vi.fn() }));
vi.mock('@cloudflare/sandbox', () => ({ getSandbox: sandboxMocks.getSandbox }));

describe('BuilderWorkspaceRepository backup authority', () => {
  beforeEach(() => sandboxMocks.getSandbox.mockReset());

  it('seeds files into a sandbox backup without storing file contents in SQLite', async () => {
    const harness = createHarness();
    await harness.workspace.beginSeed('seed_initial');
    await harness.workspace.appendSeed('seed_initial', [
      { path: '/home/project/src/index.ts', content: 'export const value = 1;\n' },
      { path: '/home/project/package.json', content: '{"dependencies":{}}\n' },
    ]);
    const state = await harness.workspace.commitSeed('seed_initial', { fileCount: 2, totalBytes: 44 });

    expect(state).toMatchObject({ initialized: true, revision: 1, fileCount: 2 });
    expect(harness.database.prepare('SELECT backup_json FROM builder_workspace_meta').get()).toMatchObject({
      backup_json: expect.stringContaining('backup-1'),
    });
    expect(
      harness.database.prepare(`SELECT sql FROM sqlite_master WHERE name = 'builder_workspace_files'`).get(),
    ).not.toEqual(expect.objectContaining({ sql: expect.stringContaining('content') }));

    const page = await harness.workspace.getSyncPage({ fromRevision: 0 });
    expect(page.entries).toEqual([
      expect.objectContaining({ path: '/home/project/package.json', content: '{"dependencies":{}}\n' }),
      expect.objectContaining({ path: '/home/project/src/index.ts', content: 'export const value = 1;\n' }),
    ]);
  });

  it('creates a new backup for an accepted browser edit and deletes the superseded backup', async () => {
    const harness = createHarness();
    await seed(harness.workspace);
    const firstBackup = harness.workspace.getBackupHandle();

    const result = await harness.workspace.applyClientChanges({
      baseRevision: 1,
      changes: [{ kind: 'write', path: '/home/project/src/index.ts', content: 'export const value = 2;\n' }],
    });

    expect(result).toMatchObject({ ok: true, state: { revision: 2 } });
    expect(harness.workspace.getBackupHandle().id).not.toBe(firstBackup.id);
    expect(harness.backend.retireBackup).toHaveBeenCalledWith(firstBackup, expect.any(Number));
    await expect(harness.workspace.readText('/home/project/src/index.ts')).resolves.toMatchObject({
      content: 'export const value = 2;\n',
    });
  });

  it('rejects stale browser edits without creating another backup', async () => {
    const harness = createHarness();
    await seed(harness.workspace);
    const before = harness.sandbox.backups.size;
    await expect(
      harness.workspace.applyClientChanges({
        baseRevision: 0,
        changes: [{ kind: 'write', path: '/home/project/src/index.ts', content: 'stale\n' }],
      }),
    ).resolves.toMatchObject({ ok: false, conflict: true, state: { revision: 1 } });
    expect(harness.sandbox.backups.size).toBe(before);
  });
});

async function seed(workspace: BuilderWorkspaceRepository) {
  await workspace.beginSeed('seed_initial');
  await workspace.appendSeed('seed_initial', [
    { path: '/home/project/src/index.ts', content: 'export const value = 1;\n' },
  ]);
  await workspace.commitSeed('seed_initial', { fileCount: 1, totalBytes: 24 });
}

function createHarness() {
  const database = new DatabaseSync(':memory:');
  const storage = new SqlStorageHarness(database);
  initializeWorkspaceRuntimeSchema(storage as never);
  const sandbox = new FakeSandbox();
  sandboxMocks.getSandbox.mockReturnValue(sandbox);
  const deletedKeys: string[] = [];
  const backend = {
    sandbox,
    localBackup: true,
    installDependencies: vi.fn(),
    retireBackup: vi.fn(),
    backupBucket: {
      delete: vi.fn(async (keys: string | string[]) => {
        deletedKeys.push(...(Array.isArray(keys) ? keys : [keys]));
      }),
    },
  };
  return {
    database,
    sandbox,
    backend,
    deletedKeys,
    workspace: new BuilderWorkspaceRepository(storage as never, backend as never, 'test-object'),
  };
}

class FakeSandbox {
  readonly files = new Map<string, string>();
  readonly backups = new Map<string, Map<string, string>>();
  #nextBackup = 1;

  async exec(command: string) {
    if (command.includes('rm -rf /workspace/project')) {
      for (const path of [...this.files.keys()]) {
        if (path.startsWith('/workspace/project/')) {
          this.files.delete(path);
        }
      }
    }
    if (command.includes('cat /tmp/ghostbuild-project-backup')) {
      const expected = command.match(/= '([^']+)'/)?.[1];
      return result(this.files.get('/tmp/ghostbuild-project-backup') === expected);
    }
    return result(true);
  }

  async writeFile(path: string, content: string | ReadableStream<Uint8Array>) {
    const value =
      typeof content === 'string' ? content : new TextDecoder().decode(await new Response(content).arrayBuffer());
    this.files.set(path, value);
    return { success: true, path, bytesWritten: value.length, timestamp: new Date().toISOString() };
  }

  async readFile(path: string) {
    const content = this.files.get(path);
    return content === undefined
      ? { success: false, path, error: 'missing', timestamp: new Date().toISOString() }
      : { success: true, path, content, timestamp: new Date().toISOString() };
  }

  async deleteFile(path: string) {
    this.files.delete(path);
    return { success: true, path, timestamp: new Date().toISOString() };
  }

  async createBackup(options: { dir: string; localBucket?: boolean }) {
    const id = `backup-${this.#nextBackup++}`;
    this.backups.set(id, new Map([...this.files].filter(([path]) => path.startsWith(`${options.dir}/`))));
    return { id, dir: options.dir, ...(options.localBucket ? { localBucket: true } : {}) };
  }

  async restoreBackup(backup: { id: string; dir: string }) {
    const stored = this.backups.get(backup.id);
    if (!stored) {
      throw new Error('missing backup');
    }
    for (const path of [...this.files.keys()]) {
      if (path.startsWith(`${backup.dir}/`)) {
        this.files.delete(path);
      }
    }
    for (const [path, content] of stored) {
      this.files.set(path, content);
    }
    return { success: true, id: backup.id, dir: backup.dir };
  }

  async mkdir() {
    return { success: true, path: '/workspace/project', timestamp: new Date().toISOString() };
  }
  async killAllProcesses() {
    return 0;
  }
  async destroy() {
    return undefined;
  }
}

function result(success: boolean) {
  return {
    success,
    exitCode: success ? 0 : 1,
    stdout: '',
    stderr: '',
    command: '',
    duration: 0,
    timestamp: new Date().toISOString(),
  };
}

class SqlStorageHarness {
  readonly sql;
  constructor(private readonly database: DatabaseSync) {
    this.sql = {
      exec: <T = Record<string, unknown>>(query: string, ...bindings: unknown[]): Iterable<T> => {
        const normalized = query.trim();
        if (bindings.length === 0 && normalized.includes(';')) {
          this.database.exec(query);
          return [];
        }
        const statement = this.database.prepare(query);
        if (/^(SELECT|WITH)\b/i.test(normalized)) {
          return statement.all(...(bindings as never[])) as T[];
        }
        statement.run(...(bindings as never[]));
        return [];
      },
    };
  }
  transactionSync<T>(closure: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const value = closure();
      this.database.exec('COMMIT');
      return value;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}
