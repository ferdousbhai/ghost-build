import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import type {
  BuilderWorkspaceApplyResult,
  BuilderWorkspaceClientChange,
  BuilderWorkspaceState,
} from '~/agents/builder-workspace-types';
import type { AccountLocalReplica } from '~/lib/cloudflare/account-local-replica';
import {
  createBuilderWorkspaceCollection,
  type BuilderWorkspaceAgent,
  type BuilderWorkspaceCollection,
  type BuilderWorkspacePullResult,
  workspaceCollectionSnapshot,
} from './builder-workspace-collection.client';
import { workbenchStore } from './workbench.client';

const WORKSPACE_RPC_TIMEOUT_MS = 30_000;
const logger = createScopedLogger('BuilderWorkspaceSyncController');

/**
 * Keeps the browser presentation and its persisted TanStack DB collection
 * aligned with the authoritative Durable Object workspace. Browser writes are
 * single-revision CAS operations; conflicts reload server state and never
 * rebase a stale local edit.
 */
export class BuilderWorkspaceSyncController {
  #revision = 0;
  #operationQueue: Promise<void> = Promise.resolve();
  #disposed = false;
  readonly #changeListener = (changes: BuilderWorkspaceClientChange[]) => this.push(changes);

  private constructor(
    private readonly agent: BuilderWorkspaceAgent,
    private readonly workspaceId: string,
    private readonly collection: BuilderWorkspaceCollection,
    private readonly source: ReturnType<typeof createBuilderWorkspaceCollection>['source'],
  ) {}

  static async initialize(
    agent: BuilderWorkspaceAgent,
    options: { workspaceId?: string; replica?: AccountLocalReplica | null } = {},
  ): Promise<BuilderWorkspaceSyncController> {
    const workspaceId = options.workspaceId ?? 'active';
    workbenchStore.activateWorkspace(workspaceId);
    const state = await callAgent<BuilderWorkspaceState>(agent, 'getWorkspaceState', []);
    if (!workbenchStore.isWorkspaceActive(workspaceId)) {
      throw new Error('The durable workspace connection was superseded.');
    }
    if (!state.initialized) {
      throw new Error('The durable project workspace is not initialized.');
    }
    const { collection, source } = createBuilderWorkspaceCollection({
      agent,
      workspaceId,
      replica: options.replica ?? null,
    });
    const controller = new BuilderWorkspaceSyncController(agent, workspaceId, collection, source);
    workbenchStore.setWorkspaceChangeListener(controller.#changeListener);
    const initialPullOutcome = source.initialPull.then(
      (pull) => ({ ok: true as const, pull }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    try {
      await collection.preload();
      controller.#replacePresentationFromCollection();
      const initialPull = await initialPullOutcome;
      if (!initialPull.ok) {
        throw initialPull.error;
      }
      controller.#revision = initialPull.pull.revision;
      controller.#presentPull(initialPull.pull);
      return controller;
    } catch (error) {
      controller.dispose();
      throw error;
    }
  }

  get revision(): number {
    return this.#revision;
  }

  dispose(): void {
    this.#disposed = true;
    workbenchStore.clearWorkspaceChangeListener(this.#changeListener);
    void this.collection.cleanup();
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
          try {
            const pull = await this.source.pull();
            this.#revision = pull.revision;
            this.#presentPull(pull);
          } catch (error) {
            // The edit is already durable. Preserve success and let the next
            // normal reconciliation retry the browser replica update.
            logger.warn('Failed to refresh the browser workspace replica after a durable edit', error);
          }
        } else {
          const pull = await this.source.replaceFromSnapshot();
          this.#revision = pull.revision;
          this.#replacePresentationFromCollection();
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
    return this.#enqueue(async () => {
      const pull = await this.source.pull();
      this.#revision = pull.revision;
      this.#presentPull(pull);
    });
  }

  #presentPull(pull: BuilderWorkspacePullResult): void {
    if (!workbenchStore.isWorkspaceActive(this.workspaceId)) {
      return;
    }
    if (pull.mode === 'snapshot') {
      this.#replacePresentationFromCollection();
    } else if (pull.entries.length > 0) {
      workbenchStore.applyWorkspaceSyncEntries(pull.entries);
    }
  }

  #replacePresentationFromCollection(): void {
    if (workbenchStore.isWorkspaceActive(this.workspaceId)) {
      workbenchStore.replaceWorkspaceSnapshot(workspaceCollectionSnapshot(this.collection));
    }
  }

  async #call<T>(method: string, args: unknown[]): Promise<T> {
    return callAgent<T>(this.agent, method, args);
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const execution = this.#operationQueue.then(operation);
    this.#operationQueue = execution.catch(() => undefined);
    return execution;
  }
}

async function callAgent<T>(agent: BuilderWorkspaceAgent, method: string, args: unknown[]): Promise<T> {
  return (await agent.call(method, args, { timeout: WORKSPACE_RPC_TIMEOUT_MS })) as T;
}
