import type {
  BuilderWorkspaceApplyResult,
  BuilderWorkspaceClientChange,
  BuilderWorkspaceState,
  BuilderWorkspaceSyncEntry,
  BuilderWorkspaceSyncPage,
} from '~/agents/builder-workspace-types';
import {
  BUILDER_WORKSPACE_SYNC_BATCH_BYTES,
  BUILDER_WORKSPACE_SYNC_BATCH_FILES,
} from '~/agents/builder-workspace-types';
import { workbenchStore } from './workbench.client';

type BuilderWorkspaceAgent = {
  call(method: string, args: unknown[], options?: { timeout?: number }): Promise<unknown>;
};

const WORKSPACE_RPC_TIMEOUT_MS = 30_000;
const WORKSPACE_SYNC_RETRIES = 3;

export class BuilderWorkspaceSyncController {
  #revision = 0;
  #operationQueue: Promise<void> = Promise.resolve();
  #pendingChanges = new Map<string, BuilderWorkspaceClientChange>();
  #disposed = false;
  readonly #changeListener = (changes: BuilderWorkspaceClientChange[]) => this.push(changes);
  readonly #readyWaiter = () => this.pull();

  private constructor(private readonly agent: BuilderWorkspaceAgent) {}

  static async initialize(agent: BuilderWorkspaceAgent): Promise<BuilderWorkspaceSyncController> {
    const controller = new BuilderWorkspaceSyncController(agent);
    const state = await controller.#call<BuilderWorkspaceState>('getWorkspaceState', []);
    if (!state.initialized) {
      throw new Error('The durable project workspace is not initialized.');
    }
    controller.#revision = 0;
    await controller.pull();
    workbenchStore.setWorkspaceChangeListener(controller.#changeListener);
    workbenchStore.setWorkspaceReadyWaiter(controller.#readyWaiter);
    return controller;
  }

  get revision(): number {
    return this.#revision;
  }

  dispose(): void {
    this.#disposed = true;
    workbenchStore.clearWorkspaceChangeListener(this.#changeListener);
    workbenchStore.clearWorkspaceReadyWaiter(this.#readyWaiter);
  }

  push(changes: BuilderWorkspaceClientChange[]): Promise<void> {
    if (this.#disposed || changes.length === 0) {
      return Promise.resolve();
    }
    for (const change of changes) {
      this.#pendingChanges.set(change.path, change);
    }
    return this.#enqueue(() => this.#flushPendingChanges());
  }

  pull(): Promise<void> {
    if (this.#disposed) {
      return Promise.resolve();
    }
    return this.#enqueue(async () => {
      await this.#flushPendingChanges();
      await this.#pullFromRevision();
    });
  }

  async #pushBatch(changes: BuilderWorkspaceClientChange[]): Promise<void> {
    let baseRevision = this.#revision;
    const preservedPaths = new Set(changes.map((change) => change.path));
    for (let attempt = 0; attempt < WORKSPACE_SYNC_RETRIES; attempt += 1) {
      const result = await this.#call<BuilderWorkspaceApplyResult>('applyWorkspaceClientChanges', [
        { baseRevision, changes },
      ]);
      if (result.ok) {
        this.#revision = result.state.revision;
        return;
      }
      await this.#pullFromRevision(preservedPaths);
      baseRevision = this.#revision;
    }
    throw new Error('The project changed repeatedly while browser edits were being synchronized.');
  }

  async #flushPendingChanges(): Promise<void> {
    while (!this.#disposed && this.#pendingChanges.size > 0) {
      const pending = Array.from(this.#pendingChanges.values());
      for (const batch of batchChanges(pending)) {
        await this.#pushBatch(batch);
        for (const change of batch) {
          if (this.#pendingChanges.get(change.path) === change) {
            this.#pendingChanges.delete(change.path);
          }
        }
      }
    }
  }

  async #pullFromRevision(preservedPaths = new Set<string>()): Promise<void> {
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
        targetRevision = undefined;
        cursor = undefined;
        snapshotEntries = null;
        continue;
      }
      targetRevision = page.targetRevision;
      this.#revision = page.targetRevision;
      if (page.mode === 'snapshot') {
        snapshotEntries ??= [];
        snapshotEntries.push(...page.entries.filter((entry) => !preservedPaths.has(entry.path)));
      } else if (page.entries.length > 0) {
        await workbenchStore.applyWorkspaceSyncEntries(page.entries.filter((entry) => !preservedPaths.has(entry.path)));
      }
      if (!page.nextCursor) {
        if (snapshotEntries) {
          await workbenchStore.replaceWorkspaceSnapshot(snapshotEntries, preservedPaths);
        }
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

function batchChanges(changes: BuilderWorkspaceClientChange[]): BuilderWorkspaceClientChange[][] {
  return batchBySize(changes, (change) => change.path.length + (change.kind === 'write' ? change.content.length : 0));
}

function batchBySize<T>(values: T[], size: (value: T) => number): T[][] {
  const batches: T[][] = [];
  let batch: T[] = [];
  let batchSize = 0;
  for (const value of values) {
    const valueSize = size(value);
    if (
      batch.length > 0 &&
      (batch.length >= BUILDER_WORKSPACE_SYNC_BATCH_FILES || batchSize + valueSize > BUILDER_WORKSPACE_SYNC_BATCH_BYTES)
    ) {
      batches.push(batch);
      batch = [];
      batchSize = 0;
    }
    batch.push(value);
    batchSize += valueSize;
  }
  if (batch.length > 0) {
    batches.push(batch);
  }
  return batches;
}
