import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { BuilderWorkspaceClientChange, BuilderWorkspaceSyncEntry } from '~/agents/builder-workspace-types';

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
