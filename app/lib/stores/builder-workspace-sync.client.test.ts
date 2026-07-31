import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { SyncConfig } from '@tanstack/db';
import type { BuilderWorkspaceClientChange, BuilderWorkspaceSyncEntry } from '~/agents/builder-workspace-types';
import type { AccountLocalReplica } from '~/lib/cloudflare/account-local-replica';
import type { BuilderWorkspaceFileRecord } from './builder-workspace-collection.client';

const workbench = vi.hoisted(() => ({
  setWorkspaceChangeListener: vi.fn(),
  clearWorkspaceChangeListener: vi.fn(),
  applyWorkspaceSyncEntries: vi.fn(async (_entries: BuilderWorkspaceSyncEntry[]) => undefined),
  replaceWorkspaceSnapshot: vi.fn(
    async (_entries: BuilderWorkspaceSyncEntry[], _preservedPaths?: Set<string>) => undefined,
  ),
}));

vi.mock('./workbench.client', () => ({ workbenchStore: workbench }));

import { BuilderWorkspaceSyncController } from './builder-workspace-sync.client';

describe('BuilderWorkspaceSyncController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('never promotes browser files when the durable workspace is unavailable', async () => {
    const agent = {
      call: vi.fn(async (method: string) => {
        if (method === 'getWorkspaceState') {
          return { ...workspaceState(0), initialized: false };
        }
        throw new Error(`Unexpected RPC: ${method}`);
      }),
    };

    await expect(BuilderWorkspaceSyncController.initialize(agent)).rejects.toThrow(
      'durable project workspace is not initialized',
    );
    expect(workbench.replaceWorkspaceSnapshot).not.toHaveBeenCalled();
  });

  test('hydrates persisted rows and resumes server sync from the SQLite revision', async () => {
    let releaseServerPull: () => void = () => undefined;
    const serverPullBlocked = new Promise<void>((resolve) => {
      releaseServerPull = resolve;
    });
    const cached = fileRecord('/home/project/src/cached.ts', 'cached', 7);
    const persistedCollectionOptions = vi.fn((options: WorkspaceCollectionOptions) => ({
      ...options,
      sync: {
        ...options.sync,
        sync: (params: WorkspaceSyncParams) => {
          params.begin({ immediate: true });
          params.write({ type: 'update', value: cached });
          params.commit();
          if (!params.metadata) {
            throw new Error('Expected collection metadata support.');
          }
          return options.sync.sync({
            ...params,
            metadata: {
              ...params.metadata,
              collection: {
                ...params.metadata.collection,
                get: () => 7,
              },
            },
          });
        },
      },
    }));
    const replica = {
      persistence: {},
      persistedCollectionOptions,
    } as unknown as AccountLocalReplica;
    const agent = {
      call: vi.fn(async (method: string, args: unknown[]) => {
        switch (method) {
          case 'getWorkspaceState':
            return workspaceState(8);
          case 'getWorkspaceSyncPage': {
            await serverPullBlocked;
            const request = args[0] as { fromRevision: number };
            return syncPage(request.fromRevision, 8, 'delta', [write('/home/project/src/server.ts', 'server', 8)]);
          }
          default:
            throw new Error(`Unexpected RPC: ${method}`);
        }
      }),
    };

    const initializing = BuilderWorkspaceSyncController.initialize(agent, {
      workspaceId: 'workspace-1',
      replica,
    });
    await vi.waitFor(() =>
      expect(workbench.replaceWorkspaceSnapshot).toHaveBeenCalledWith([
        expect.objectContaining({ path: cached.path, content: cached.content }),
      ]),
    );
    releaseServerPull();
    const controller = await initializing;

    expect(persistedCollectionOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'builder-workspace:workspace-1',
        schemaVersion: 1,
      }),
    );
    expect(agent.call).toHaveBeenCalledWith(
      'getWorkspaceSyncPage',
      [{ fromRevision: 7 }],
      expect.objectContaining({ timeout: 30_000 }),
    );
    expect(workbench.applyWorkspaceSyncEntries).toHaveBeenCalledWith([
      expect.objectContaining({ path: '/home/project/src/server.ts', content: 'server' }),
    ]);
    expect(controller.revision).toBe(8);
    controller.dispose();
  });

  test('rejects a stale manual edit and replaces the presentation cache from the durable snapshot', async () => {
    const applyRequests: unknown[] = [];
    let conflicted = false;
    const agent = {
      call: vi.fn(async (method: string, args: unknown[]) => {
        switch (method) {
          case 'getWorkspaceState':
            return workspaceState(1);
          case 'getWorkspaceSyncPage': {
            const request = args[0] as { fromRevision: number };
            if (request.fromRevision === 0) {
              return conflicted
                ? syncPage(0, 2, 'snapshot', [
                    write('/home/project/src/local.ts', 'server-version', 2),
                    write('/home/project/src/remote.ts', 'remote-change', 2),
                  ])
                : syncPage(0, 1, 'snapshot', [write('/home/project/src/local.ts', 'initial', 1)]);
            }
            return syncPage(1, 2, 'delta', [
              write('/home/project/src/local.ts', 'server-version', 2),
              write('/home/project/src/remote.ts', 'remote-change', 2),
            ]);
          }
          case 'applyWorkspaceClientChanges':
            applyRequests.push(args[0]);
            conflicted = true;
            return { ok: false, conflict: true, state: workspaceState(2) };
          default:
            throw new Error(`Unexpected RPC: ${method}`);
        }
      }),
    };
    const controller = await BuilderWorkspaceSyncController.initialize(agent);
    workbench.applyWorkspaceSyncEntries.mockClear();
    const localChange: BuilderWorkspaceClientChange = {
      kind: 'write',
      path: '/home/project/src/local.ts',
      content: 'browser-version',
    };

    await controller.push([localChange]);

    expect(applyRequests).toEqual([{ baseRevision: 1, changes: [localChange] }]);
    expect(workbench.replaceWorkspaceSnapshot).toHaveBeenLastCalledWith([
      expect.objectContaining({ path: '/home/project/src/local.ts', content: 'server-version' }),
      expect.objectContaining({ path: '/home/project/src/remote.ts', content: 'remote-change' }),
    ]);
    expect(controller.revision).toBe(2);
  });

  test('atomically replaces stale rows when the server restarts a paged delta as a snapshot', async () => {
    let restarting = false;
    const agent = {
      call: vi.fn(async (method: string, args: unknown[]) => {
        switch (method) {
          case 'getWorkspaceState':
            return workspaceState(1);
          case 'getWorkspaceSyncPage': {
            const request = args[0] as { fromRevision: number; cursor?: string; targetRevision?: number };
            if (!restarting && request.fromRevision === 0) {
              return syncPage(0, 1, 'snapshot', [write('/home/project/src/stale.ts', 'stale', 1)]);
            }
            if (request.fromRevision === 1) {
              restarting = true;
              return { ...syncPage(1, 2, 'current', []), restart: true };
            }
            if (!request.cursor) {
              return {
                ...syncPage(0, 2, 'snapshot', [write('/home/project/src/one.ts', 'one', 2)]),
                nextCursor: '1',
              };
            }
            expect(request).toEqual({ fromRevision: 0, targetRevision: 2, cursor: '1' });
            return syncPage(0, 2, 'snapshot', [write('/home/project/src/two.ts', 'two', 2)]);
          }
          default:
            throw new Error(`Unexpected RPC: ${method}`);
        }
      }),
    };
    const controller = await BuilderWorkspaceSyncController.initialize(agent);

    await controller.pull();

    expect(workbench.replaceWorkspaceSnapshot).toHaveBeenLastCalledWith([
      expect.objectContaining({ path: '/home/project/src/one.ts', content: 'one' }),
      expect.objectContaining({ path: '/home/project/src/two.ts', content: 'two' }),
    ]);
    expect(workbench.replaceWorkspaceSnapshot).not.toHaveBeenLastCalledWith([
      expect.objectContaining({ path: '/home/project/src/stale.ts' }),
    ]);
    expect(controller.revision).toBe(2);
  });

  test('does not silently retry a failed manual edit during a later pull', async () => {
    let applyCount = 0;
    const agent = {
      call: vi.fn(async (method: string, args: unknown[]) => {
        switch (method) {
          case 'getWorkspaceState':
            return workspaceState(1);
          case 'getWorkspaceSyncPage': {
            const request = args[0] as { fromRevision: number };
            return request.fromRevision === 0
              ? syncPage(0, 1, 'snapshot', [])
              : syncPage(request.fromRevision, 2, 'current', []);
          }
          case 'applyWorkspaceClientChanges':
            applyCount += 1;
            if (applyCount === 1) {
              throw new Error('temporary connection failure');
            }
            return {
              ok: true,
              state: workspaceState(2),
              changedPaths: [(args[0] as { changes: BuilderWorkspaceClientChange[] }).changes[0]!.path],
            };
          default:
            throw new Error(`Unexpected RPC: ${method}`);
        }
      }),
    };
    const controller = await BuilderWorkspaceSyncController.initialize(agent);
    const change: BuilderWorkspaceClientChange = {
      kind: 'write',
      path: '/home/project/src/retry.ts',
      content: 'retry me',
    };

    await expect(controller.push([change])).rejects.toThrow('temporary connection failure');
    await expect(controller.pull()).resolves.toBeUndefined();

    expect(applyCount).toBe(1);
    expect(controller.revision).toBe(2);
  });

  test('serializes push and pull operations through one workspace queue', async () => {
    let revision = 1;
    let activeApplyCalls = 0;
    let maximumActiveApplyCalls = 0;
    let releaseFirstApply: () => void = () => undefined;
    let firstApply = true;
    const agent = {
      call: vi.fn(async (method: string, args: unknown[]) => {
        switch (method) {
          case 'getWorkspaceState':
            return workspaceState(1);
          case 'getWorkspaceSyncPage': {
            const request = args[0] as { fromRevision: number };
            return request.fromRevision === 0
              ? syncPage(0, 1, 'snapshot', [])
              : syncPage(request.fromRevision, revision, 'current', []);
          }
          case 'applyWorkspaceClientChanges': {
            activeApplyCalls += 1;
            maximumActiveApplyCalls = Math.max(maximumActiveApplyCalls, activeApplyCalls);
            if (firstApply) {
              firstApply = false;
              await new Promise<void>((resolve) => {
                releaseFirstApply = resolve;
              });
            }
            revision += 1;
            activeApplyCalls -= 1;
            return {
              ok: true,
              state: workspaceState(revision),
              changedPaths: (args[0] as { changes: BuilderWorkspaceClientChange[] }).changes.map(
                (change) => change.path,
              ),
            };
          }
          default:
            throw new Error(`Unexpected RPC: ${method}`);
        }
      }),
    };
    const controller = await BuilderWorkspaceSyncController.initialize(agent);
    const firstPush = controller.push([{ kind: 'write', path: '/home/project/src/one.ts', content: 'one' }]);
    await vi.waitFor(() => expect(activeApplyCalls).toBe(1));
    const pull = controller.pull();
    const secondPush = controller.push([{ kind: 'write', path: '/home/project/src/two.ts', content: 'two' }]);

    releaseFirstApply();
    await Promise.all([firstPush, pull, secondPush]);

    expect(maximumActiveApplyCalls).toBe(1);
    expect(agent.call.mock.calls.filter(([method]) => method === 'applyWorkspaceClientChanges')).toHaveLength(2);
  });
});

function workspaceState(revision: number) {
  return {
    initialized: true,
    revision,
    resetRevision: 1,
    fileCount: 1,
    totalBytes: 1,
    seeding: false,
  };
}

function syncPage(
  fromRevision: number,
  targetRevision: number,
  mode: 'current' | 'snapshot' | 'delta',
  entries: BuilderWorkspaceSyncEntry[],
) {
  return {
    state: workspaceState(targetRevision),
    fromRevision,
    targetRevision,
    mode,
    entries,
  };
}

function write(path: string, content: string, revision: number): BuilderWorkspaceSyncEntry {
  return {
    kind: 'write',
    path,
    content,
    encoding: 'utf8',
    size: content.length,
    sha256: `${revision}`,
    revision,
  };
}

type WorkspaceSyncParams = Parameters<SyncConfig<BuilderWorkspaceFileRecord, string>['sync']>[0];
type WorkspaceCollectionOptions = {
  id: string;
  schemaVersion: number;
  sync: SyncConfig<BuilderWorkspaceFileRecord, string>;
  [key: string]: unknown;
};

function fileRecord(path: string, content: string, revision: number): BuilderWorkspaceFileRecord {
  return {
    path,
    content,
    encoding: 'utf8',
    size: content.length,
    sha256: `${revision}`,
    revision,
  };
}
