import type {
  BuilderWorkspaceApplyResult,
  BuilderWorkspaceClientChange,
  BuilderWorkspaceState,
  BuilderWorkspaceSyncEntry,
  BuilderWorkspaceSyncPage,
} from '~/agents/builder-workspace-types';
import { workbenchStore } from './workbench.client';

type BuilderWorkspaceAgent = {
  call(method: string, args: unknown[], options?: { timeout?: number }): Promise<unknown>;
};

const WORKSPACE_RPC_TIMEOUT_MS = 30_000;

/**
 * Keeps a rebuildable browser presentation cache aligned with the authoritative
 * Durable Object workspace. Browser writes are single-revision CAS operations:
 * conflicts reload server state and never rebase a stale local edit.
 */
export class BuilderWorkspaceSyncController {
  #revision = 0;
  #operationQueue: Promise<void> = Promise.resolve();
  #disposed = false;
  readonly #changeListener = (changes: BuilderWorkspaceClientChange[]) => this.push(changes);

  private constructor(private readonly agent: BuilderWorkspaceAgent) {}

  static async initialize(agent: BuilderWorkspaceAgent): Promise<BuilderWorkspaceSyncController> {
    const controller = new BuilderWorkspaceSyncController(agent);
    const state = await controller.#call<BuilderWorkspaceState>('getWorkspaceState', []);
    if (!state.initialized) {
      throw new Error('The durable project workspace is not initialized.');
    }
    await controller.#replaceFromSnapshot();
    workbenchStore.setWorkspaceChangeListener(controller.#changeListener);
    return controller;
  }

  get revision(): number {
    return this.#revision;
  }

  dispose(): void {
    this.#disposed = true;
    workbenchStore.clearWorkspaceChangeListener(this.#changeListener);
  }

  async push(changes: BuilderWorkspaceClientChange[]): Promise<BuilderWorkspaceApplyResult> {
    if (this.#disposed) {
      throw new Error('The durable workspace connection was closed.');
    }
    if (changes.length === 0) {
      return { ok: true, state: await this.#call('getWorkspaceState', []), changedPaths: [] };
    }
    let resolveResult: (result: BuilderWorkspaceApplyResult) => void = () => undefined;
    let rejectResult: (error: unknown) => void = () => undefined;
    const result = new Promise<BuilderWorkspaceApplyResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.#enqueue(async () => {
      try {
        const applied = await this.#call<BuilderWorkspaceApplyResult>('applyWorkspaceClientChanges', [
          { baseRevision: this.#revision, changes },
        ]);
        if (applied.ok) {
          this.#revision = applied.state.revision;
        } else {
          await this.#replaceFromSnapshot();
        }
        resolveResult(applied);
      } catch (error) {
        rejectResult(error);
      }
    });
    return result;
  }

  pull(): Promise<void> {
    if (this.#disposed) {
      return Promise.resolve();
    }
    return this.#enqueue(() => this.#pullFromRevision());
  }

  async #pullFromRevision(): Promise<void> {
    const fromRevision = this.#revision;
    let targetRevision: number | undefined;
    let cursor: string | undefined;
    let snapshotEntries: BuilderWorkspaceSyncEntry[] | null = null;
    while (true) {
      const page = await this.#call<BuilderWorkspaceSyncPage>('getWorkspaceSyncPage', [
        {
          fromRevision,
          ...(targetRevision !== undefined ? { targetRevision } : {}),
          ...(cursor ? { cursor } : {}),
        },
      ]);
      if (page.restart) {
        await this.#replaceFromSnapshot();
        return;
      }
      targetRevision = page.targetRevision;
      if (page.mode === 'snapshot') {
        snapshotEntries ??= [];
        snapshotEntries.push(...page.entries);
      } else {
        workbenchStore.applyWorkspaceSyncEntries(page.entries);
      }
      if (!page.nextCursor) {
        this.#revision = page.targetRevision;
        if (snapshotEntries) {
          workbenchStore.replaceWorkspaceSnapshot(snapshotEntries);
        }
        return;
      }
      cursor = page.nextCursor;
    }
  }

  async #replaceFromSnapshot(): Promise<void> {
    let cursor: string | undefined;
    let targetRevision: number | undefined;
    const entries: BuilderWorkspaceSyncEntry[] = [];
    while (true) {
      const page = await this.#call<BuilderWorkspaceSyncPage>('getWorkspaceSyncPage', [
        {
          fromRevision: 0,
          ...(targetRevision !== undefined ? { targetRevision } : {}),
          ...(cursor ? { cursor } : {}),
        },
      ]);
      if (page.restart) {
        cursor = undefined;
        targetRevision = undefined;
        entries.length = 0;
        continue;
      }
      targetRevision = page.targetRevision;
      entries.push(...page.entries);
      if (!page.nextCursor) {
        this.#revision = page.targetRevision;
        workbenchStore.replaceWorkspaceSnapshot(entries);
        return;
      }
      cursor = page.nextCursor;
    }
  }

  async #call<T>(method: string, args: unknown[]): Promise<T> {
    return (await this.agent.call(method, args, { timeout: WORKSPACE_RPC_TIMEOUT_MS })) as T;
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const execution = this.#operationQueue.then(operation);
    this.#operationQueue = execution.catch(() => undefined);
    return execution;
  }
}
