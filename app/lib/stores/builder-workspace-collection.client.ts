import { createCollection, type SyncConfig } from '@tanstack/db';
import { z } from 'zod';
import type {
  BuilderWorkspaceEncoding,
  BuilderWorkspaceSyncEntry,
  BuilderWorkspaceSyncPage,
} from '~/agents/builder-workspace-types';
import type { AccountLocalReplica } from '~/lib/cloudflare/account-local-replica';

const WORKSPACE_REVISION_METADATA_KEY = 'workspaceRevision';
const WORKSPACE_COLLECTION_SCHEMA_VERSION = 1;
const WORKSPACE_RPC_TIMEOUT_MS = 30_000;

export type BuilderWorkspaceFileRecord = {
  path: string;
  content: string;
  encoding: BuilderWorkspaceEncoding;
  size: number;
  sha256: string;
  revision: number;
};

const workspaceFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  encoding: z.enum(['utf8', 'base64']),
  size: z.number().int().nonnegative(),
  sha256: z.string().min(1),
  revision: z.number().int().nonnegative(),
}) satisfies z.ZodType<BuilderWorkspaceFileRecord>;

export type BuilderWorkspaceAgent = {
  call(method: string, args: unknown[], options?: { timeout?: number }): Promise<unknown>;
};

type WorkspaceSyncParams = Parameters<SyncConfig<BuilderWorkspaceFileRecord, string>['sync']>[0];

export type BuilderWorkspacePullResult = {
  mode: 'current' | 'snapshot' | 'delta';
  entries: BuilderWorkspaceSyncEntry[];
  revision: number;
};

/**
 * Bridges the BuilderAgent revision protocol into a TanStack DB sync source.
 * The persistence wrapper hydrates committed rows and collection metadata from
 * browser SQLite before this source requests server changes.
 */
class BuilderWorkspaceCollectionSource {
  #params: WorkspaceSyncParams | null = null;
  #disposed = false;
  #revision = 0;
  readonly #started = deferred<void>();
  readonly #initialPull = deferred<BuilderWorkspacePullResult>();

  constructor(private readonly agent: BuilderWorkspaceAgent) {}

  readonly sync: SyncConfig<BuilderWorkspaceFileRecord, string> = {
    rowUpdateMode: 'full',
    sync: (params) => {
      this.#params = params;
      this.#revision = persistedRevision(params.metadata?.collection.get(WORKSPACE_REVISION_METADATA_KEY));
      this.#started.resolve();

      // The persistence wrapper delays this mark until OPFS hydration and any
      // sync transactions buffered behind it have completed.
      params.markReady();
      void this.#pullFromRevision(this.#revision).then(this.#initialPull.resolve, this.#initialPull.reject);

      return () => {
        this.#disposed = true;
        this.#params = null;
      };
    },
  };

  get revision(): number {
    return this.#revision;
  }

  get initialPull(): Promise<BuilderWorkspacePullResult> {
    return this.#initialPull.promise;
  }

  async pull(): Promise<BuilderWorkspacePullResult> {
    await this.#started.promise;
    return this.#pullFromRevision(this.#revision);
  }

  async replaceFromSnapshot(): Promise<BuilderWorkspacePullResult> {
    await this.#started.promise;
    return this.#pullFromRevision(0);
  }

  async #pullFromRevision(initialFromRevision: number): Promise<BuilderWorkspacePullResult> {
    let fromRevision = initialFromRevision;
    while (true) {
      let cursor: string | undefined;
      let targetRevision: number | undefined;
      let mode: BuilderWorkspacePullResult['mode'] = 'current';
      const entries: BuilderWorkspaceSyncEntry[] = [];
      let restart = false;

      do {
        const page = await this.#call<BuilderWorkspaceSyncPage>('getWorkspaceSyncPage', [
          {
            fromRevision,
            ...(targetRevision !== undefined ? { targetRevision } : {}),
            ...(cursor ? { cursor } : {}),
          },
        ]);
        if (!page.state.initialized) {
          throw new Error('The durable project workspace is not initialized.');
        }
        if (page.restart) {
          fromRevision = 0;
          restart = true;
          break;
        }
        targetRevision = page.targetRevision;
        mode = page.mode;
        entries.push(...page.entries);
        cursor = page.nextCursor;
      } while (cursor);

      if (restart) {
        continue;
      }
      if (targetRevision === undefined) {
        throw new Error('The durable workspace sync did not return a target revision.');
      }
      if (this.#disposed || !this.#params) {
        throw new Error('The durable workspace connection was closed.');
      }

      this.#commit(this.#params, mode, entries, targetRevision);
      this.#revision = targetRevision;
      return { mode, entries, revision: targetRevision };
    }
  }

  #commit(
    params: WorkspaceSyncParams,
    mode: BuilderWorkspacePullResult['mode'],
    entries: BuilderWorkspaceSyncEntry[],
    revision: number,
  ): void {
    params.begin({ immediate: true });
    if (mode === 'snapshot') {
      params.truncate();
    }
    for (const entry of entries) {
      if (entry.kind === 'delete') {
        params.write({ type: 'delete', key: entry.path });
      } else {
        params.write({ type: 'update', value: entry });
      }
    }
    params.metadata?.collection.set(WORKSPACE_REVISION_METADATA_KEY, revision);
    params.commit();
  }

  async #call<T>(method: string, args: unknown[]): Promise<T> {
    return (await this.agent.call(method, args, { timeout: WORKSPACE_RPC_TIMEOUT_MS })) as T;
  }
}

export type BuilderWorkspaceCollection = ReturnType<typeof createBuilderWorkspaceCollection>['collection'];

export function createBuilderWorkspaceCollection(args: {
  agent: BuilderWorkspaceAgent;
  workspaceId: string;
  replica: AccountLocalReplica | null;
}) {
  const source = new BuilderWorkspaceCollectionSource(args.agent);
  const options = {
    id: `builder-workspace:${args.workspaceId}`,
    schema: workspaceFileSchema,
    getKey: (file: BuilderWorkspaceFileRecord) => file.path,
    sync: source.sync,
  };
  const collection = createCollection(
    args.replica
      ? {
          ...args.replica.persistedCollectionOptions({
            ...options,
            persistence: args.replica.persistence,
            schemaVersion: WORKSPACE_COLLECTION_SCHEMA_VERSION,
          }),
          schema: workspaceFileSchema,
        }
      : options,
  );
  return { collection, source };
}

export function workspaceCollectionSnapshot(collection: BuilderWorkspaceCollection): BuilderWorkspaceSyncEntry[] {
  return collection.toArray
    .map((file): BuilderWorkspaceSyncEntry => ({
      kind: 'write',
      path: file.path,
      content: file.content,
      encoding: file.encoding,
      size: file.size,
      sha256: file.sha256,
      revision: file.revision,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function persistedRevision(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : 0;
}

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}
