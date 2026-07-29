import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { runBuilderAgentSchemaMigrations } from './builder-agent-schema';
import { BuilderWorkspaceRepository } from './builder-workspace';
import { BUILDER_WORKSPACE_INLINE_BYTES } from './builder-workspace-types';
import { executeBuilderWorkspaceTool } from './builder-workspace-tools';
import { createBuilderWorkspaceSnapshot } from './builder-workspace-snapshot';
import { deploymentSnapshotRevision } from '~/lib/runtime/action-runner/revision';

describe('BuilderWorkspaceRepository', () => {
  it('atomically seeds a workspace and returns it as a revisioned snapshot', async () => {
    const harness = createHarness();
    const seed = await harness.workspace.beginSeed('seed_initial');
    expect(seed.status).toBe('started');

    await harness.workspace.appendSeed('seed_initial', [
      { path: '/home/project/src/index.ts', content: 'export const value = 1;\n' },
      { path: '/home/project/package.json', content: '{"dependencies":{}}\n' },
    ]);
    const state = await harness.workspace.commitSeed('seed_initial', {
      fileCount: 2,
      totalBytes: 44,
    });

    expect(state).toMatchObject({ initialized: true, revision: 1, fileCount: 2, totalBytes: 44 });
    const page = await harness.workspace.getSyncPage({ fromRevision: 0 });
    expect(page.mode).toBe('snapshot');
    expect(page.targetRevision).toBe(1);
    expect(page.entries).toEqual([
      expect.objectContaining({ kind: 'write', path: '/home/project/package.json' }),
      expect.objectContaining({
        kind: 'write',
        path: '/home/project/src/index.ts',
        content: 'export const value = 1;\n',
      }),
    ]);
  });

  it('reports an active initialization lease without allowing a second seed to replace it', async () => {
    const harness = createHarness();
    await expect(harness.workspace.beginSeed('seed_primary')).resolves.toMatchObject({ status: 'started' });
    await expect(harness.workspace.beginSeed('seed_secondary')).resolves.toMatchObject({
      status: 'seeding',
      state: { initialized: false, seeding: true },
    });
  });

  it('waits for stale seed object cleanup before replacing the initialization lease', async () => {
    const harness = createHarness();
    const startedAt = Date.now();
    await harness.workspace.beginSeed('seed_primary');
    await harness.workspace.appendSeed('seed_primary', [
      {
        path: '/home/project/src/large.ts',
        content: 'x'.repeat(BUILDER_WORKSPACE_INLINE_BYTES + 1),
      },
    ]);
    expect(harness.objects.size).toBe(1);

    let releaseDelete: () => void = () => undefined;
    harness.bucket.delete.mockImplementationOnce(
      (keys: string | string[]) =>
        new Promise<void>((resolve) => {
          releaseDelete = () => {
            for (const key of Array.isArray(keys) ? keys : [keys]) {
              harness.objects.delete(key);
            }
            resolve();
          };
        }),
    );
    const now = vi.spyOn(Date, 'now').mockReturnValue(startedAt + 11 * 60 * 1_000);
    let settled = false;
    const replacement = harness.workspace.beginSeed('seed_replacement').finally(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(harness.bucket.delete).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    releaseDelete();
    await expect(replacement).resolves.toMatchObject({ status: 'started', seedId: 'seed_replacement' });
    expect(harness.objects.size).toBe(0);
    now.mockRestore();
  });

  it('uses optimistic revisions and treats an already-applied browser echo as a no-op', async () => {
    const harness = await initializedHarness();
    const write = {
      kind: 'write' as const,
      path: '/home/project/src/index.ts',
      content: 'export const value = 2;\n',
      encoding: 'utf8' as const,
    };
    const first = await harness.workspace.applyClientChanges({ baseRevision: 1, changes: [write] });
    expect(first).toMatchObject({ ok: true, state: { revision: 2 }, changedPaths: [write.path] });

    const echo = await harness.workspace.applyClientChanges({ baseRevision: 1, changes: [write] });
    expect(echo).toMatchObject({ ok: true, state: { revision: 2 }, changedPaths: [] });

    const conflict = await harness.workspace.applyClientChanges({
      baseRevision: 1,
      changes: [{ ...write, content: 'export const value = 3;\n' }],
    });
    expect(conflict).toMatchObject({ ok: false, conflict: true, state: { revision: 2 } });
  });

  it('spills large files to R2 and removes their object after replacement', async () => {
    const harness = await initializedHarness();
    const largeContent = 'x'.repeat(BUILDER_WORKSPACE_INLINE_BYTES + 1);
    const large = await harness.workspace.applyClientChanges({
      baseRevision: 1,
      changes: [{ kind: 'write', path: '/home/project/src/large.ts', content: largeContent }],
    });
    expect(large).toMatchObject({ ok: true, state: { revision: 2 } });
    expect(harness.objects.size).toBe(1);
    await expect(harness.workspace.readText('/home/project/src/large.ts')).resolves.toMatchObject({
      content: largeContent,
    });

    const replacement = await harness.workspace.applyClientChanges({
      baseRevision: 2,
      changes: [{ kind: 'write', path: '/home/project/src/large.ts', content: 'small\n' }],
    });
    expect(replacement).toMatchObject({ ok: true, state: { revision: 3 } });
    expect(harness.objects.size).toBe(0);
  });

  it('durably reuses tool results and rejects identifier reuse with different arguments', async () => {
    const harness = await initializedHarness();
    const execute = vi.fn(async () => ({ ok: true, revision: harness.workspace.getState().revision }));
    await expect(harness.workspace.executeToolOnce('tool-1', 'view', { path: 'a' }, execute)).resolves.toEqual({
      ok: true,
      revision: 1,
    });
    await expect(harness.workspace.executeToolOnce('tool-1', 'view', { path: 'a' }, execute)).resolves.toEqual({
      ok: true,
      revision: 1,
    });
    expect(execute).toHaveBeenCalledOnce();
    await expect(harness.workspace.executeToolOnce('tool-1', 'view', { path: 'b' }, execute)).rejects.toThrow(
      'reused with different arguments',
    );
  });

  it('rejects concurrent reuse of an in-flight tool identifier with different arguments', async () => {
    const harness = await initializedHarness();
    let finish!: () => void;
    const execution = harness.workspace.executeToolOnce(
      'tool-in-flight',
      'view',
      { path: 'a' },
      () =>
        new Promise<{ ok: true }>((resolve) => {
          finish = () => resolve({ ok: true });
        }),
    );
    await Promise.resolve();

    await expect(
      harness.workspace.executeToolOnce('tool-in-flight', 'view', { path: 'b' }, async () => ({ ok: false })),
    ).rejects.toThrow('reused with different arguments');

    finish();
    await expect(execution).resolves.toEqual({ ok: true });
  });

  it('paginates snapshots without dropping the row after an exact full page', async () => {
    const harness = createHarness();
    await harness.workspace.beginSeed('seed_many_files');
    const entries = Array.from({ length: 201 }, (_, index) => ({
      path: `/home/project/src/file-${String(index).padStart(3, '0')}.ts`,
      content: `${index}`,
    }));
    for (let index = 0; index < entries.length; index += 100) {
      await harness.workspace.appendSeed('seed_many_files', entries.slice(index, index + 100));
    }
    await harness.workspace.commitSeed('seed_many_files', {
      fileCount: entries.length,
      totalBytes: entries.reduce((total, entry) => total + new TextEncoder().encode(entry.content).byteLength, 0),
    });

    const firstPage = await harness.workspace.getSyncPage({ fromRevision: 0 });
    expect(firstPage.entries).toHaveLength(200);
    expect(firstPage.nextCursor).toBe('200');

    const secondPage = await harness.workspace.getSyncPage({
      fromRevision: 0,
      targetRevision: firstPage.targetRevision,
      cursor: firstPage.nextCursor,
    });
    expect(secondPage.entries).toHaveLength(1);
    expect(secondPage.entries[0]).toMatchObject({ path: '/home/project/src/file-200.ts' });
    expect(secondPage.nextCursor).toBeUndefined();
  });

  it('enforces generated-project safety policy before durable writes', async () => {
    const harness = await initializedHarness();
    await expect(
      harness.workspace.applyClientChanges({
        baseRevision: 1,
        changes: [{ kind: 'write', path: '/home/project/.env', content: 'SECRET=value' }],
      }),
    ).rejects.toThrow('Local secret files are disabled');
  });

  it('executes and replays server filesystem mutation tools at durable revisions', async () => {
    const harness = await initializedHarness();
    const write = await executeBuilderWorkspaceTool({
      workspace: harness.workspace,
      toolCallId: 'write-1',
      toolName: 'writeFile',
      input: { path: '/home/project/src/index.ts', content: 'export const value = 2;\n' },
    });
    expect(write).toMatchObject({
      ok: true,
      data: { path: '/home/project/src/index.ts', changed: true, workspaceRevision: 2 },
    });

    const replay = await executeBuilderWorkspaceTool({
      workspace: harness.workspace,
      toolCallId: 'write-1',
      toolName: 'writeFile',
      input: { path: '/home/project/src/index.ts', content: 'export const value = 2;\n' },
    });
    expect(replay).toEqual(write);
    expect(harness.workspace.getState().revision).toBe(2);

    const view = await executeBuilderWorkspaceTool({
      workspace: harness.workspace,
      toolCallId: 'view-1',
      toolName: 'view',
      input: { path: '/home/project/src/index.ts', view_range: [1, 2] },
    });
    expect(view).toMatchObject({
      ok: true,
      data: { content: 'export const value = 2;\n', workspaceRevision: 2 },
    });
  });

  it('commits dependency manifest and lockfile changes atomically and replays without reinstalling', async () => {
    const harness = await initializedHarness();
    const prepare = vi.fn(async () => [
      { path: '/home/project/package.json', content: '{"dependencies":{"motion":"latest"}}\n' },
      { path: '/home/project/pnpm-lock.yaml', content: 'lockfileVersion: 9.0\n' },
    ]);
    const execute = () =>
      harness.workspace.commitTextFilesTool({
        toolCallId: 'npm-1',
        toolName: 'npmInstall',
        toolArgs: { packages: 'motion', workspaceRevision: 1 },
        expectedWorkspaceRevision: 1,
        prepare,
        result: ({ changedPaths, workspaceRevision }) => ({ changedPaths, workspaceRevision }),
      });

    await expect(execute()).resolves.toEqual({
      changedPaths: ['/home/project/package.json', '/home/project/pnpm-lock.yaml'],
      workspaceRevision: 2,
    });
    await expect(execute()).resolves.toEqual({
      changedPaths: ['/home/project/package.json', '/home/project/pnpm-lock.yaml'],
      workspaceRevision: 2,
    });
    expect(prepare).toHaveBeenCalledOnce();
    expect(harness.workspace.getState()).toMatchObject({ revision: 2, fileCount: 3 });
  });

  it('ties durable full validation admission to an unchanged workspace revision', async () => {
    const harness = await initializedHarness();
    harness.workspace.recordSuccessfulValidation({
      revision: 'a'.repeat(64),
      workspaceRevision: 1,
    });
    expect(harness.workspace.hasSuccessfulValidation('a'.repeat(64))).toBe(true);

    await harness.workspace.applyClientChanges({
      baseRevision: 1,
      changes: [{ kind: 'write', path: '/home/project/src/index.ts', content: 'export const value = 2;\n' }],
    });
    expect(() =>
      harness.workspace.recordSuccessfulValidation({
        revision: 'b'.repeat(64),
        workspaceRevision: 1,
      }),
    ).toThrow('advanced to revision 2');
  });

  it('creates the same content revision from the durable source ZIP and excludes build output', async () => {
    const harness = await initializedHarness();
    await harness.workspace.applyClientChanges({
      baseRevision: 1,
      changes: [
        { kind: 'write', path: '/home/project/package.json', content: '{"dependencies":{}}\n' },
        { kind: 'write', path: '/home/project/dist/index.js', content: 'generated\n' },
      ],
    });
    const snapshot = await createBuilderWorkspaceSnapshot(harness.workspace);
    expect(await deploymentSnapshotRevision(snapshot.bytes)).toBe(snapshot.revision);
    expect(snapshot.workspaceRevision).toBe(2);
  });
});

async function initializedHarness() {
  const harness = createHarness();
  await harness.workspace.beginSeed('seed_initial');
  await harness.workspace.appendSeed('seed_initial', [
    { path: '/home/project/src/index.ts', content: 'export const value = 1;\n' },
  ]);
  await harness.workspace.commitSeed('seed_initial', { fileCount: 1, totalBytes: 24 });
  return harness;
}

function createHarness() {
  const database = new DatabaseSync(':memory:');
  const storage = new SqlStorageHarness(database);
  runBuilderAgentSchemaMigrations(storage as never);
  const objects = new Map<string, Uint8Array>();
  const bucket = {
    put: vi.fn(async (key: string, value: Uint8Array) => {
      objects.set(key, new Uint8Array(value));
      return {};
    }),
    get: vi.fn(async (key: string) => {
      const value = objects.get(key);
      return value
        ? {
            arrayBuffer: async () => value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
          }
        : null;
    }),
    delete: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        objects.delete(key);
      }
    }),
  };
  return {
    bucket,
    objects,
    workspace: new BuilderWorkspaceRepository(storage as never, bucket as never, 'test-object'),
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
      const result = closure();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}
