const WORKSPACE_OPERATION_LEASE_MS = 15 * 60_000;

type OperationLaneStorage = Pick<DurableObjectStorage, 'sql' | 'transactionSync'>;

type OperationLaneRow = {
  owner: string | null;
  idempotency_key: string | null;
  kind: string | null;
  acquired_at: number | null;
  deadline: number | null;
};

export type WorkspaceOperationLease = {
  owner: string;
  idempotencyKey: string;
  kind: string;
  acquiredAt: number;
  deadline: number;
  recoveredOwner: string | null;
};

export class WorkspaceOperationConflictError extends Error {
  readonly code = 'workspace_operation_conflict';

  constructor(
    readonly activeKind: string,
    readonly retryAfterMs: number,
  ) {
    super(`ProjectWorkspace is busy with ${activeKind}; retry after ${retryAfterMs}ms.`);
    this.name = 'WorkspaceOperationConflictError';
  }
}

export class WorkspaceOperationIndeterminateError extends Error {
  readonly code = 'workspace_operation_indeterminate';

  constructor(readonly operationKind: string) {
    super(`The prior ${operationKind} operation was interrupted after it started and will not be repeated.`);
    this.name = 'WorkspaceOperationIndeterminateError';
  }
}

/**
 * Durable, fail-closed serialization for stateful ProjectWorkspace operations.
 *
 * Calls never wait inside the Durable Object. An occupied lane produces an
 * observable conflict so callers can retry without holding an RPC open. A
 * stale owner can be replaced by a different idempotency key, while replay of
 * the stale key remains indeterminate and therefore cannot repeat external
 * effects after eviction.
 */
export class WorkspaceOperationLane {
  constructor(
    private readonly storage: OperationLaneStorage,
    private readonly isOwnerActive: (owner: string) => boolean = () => false,
  ) {}

  initialize(): void {
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ghostbuild_operation_lane (
         singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
         owner TEXT,
         idempotency_key TEXT,
         kind TEXT,
         acquired_at INTEGER,
         deadline INTEGER
       )`,
    );
    this.storage.sql.exec(`INSERT OR IGNORE INTO ghostbuild_operation_lane (singleton) VALUES (1)`);
  }

  acquire(args: {
    owner: string;
    idempotencyKey: string;
    kind: string;
    now?: number;
    leaseMs?: number;
  }): WorkspaceOperationLease {
    const result = this.storage.transactionSync<
      WorkspaceOperationLease | { error: WorkspaceOperationConflictError | WorkspaceOperationIndeterminateError }
    >(() => {
      const now = args.now ?? Date.now();
      const leaseMs = args.leaseMs ?? WORKSPACE_OPERATION_LEASE_MS;
      const current = this.read();
      let recoveredOwner: string | null = null;

      if (current.owner && current.deadline !== null && (current.deadline > now || this.isOwnerActive(current.owner))) {
        return {
          error: new WorkspaceOperationConflictError(
            current.kind ?? 'stateful operation',
            Math.max(1_000, current.deadline - now),
          ),
        };
      }

      if (current.owner) {
        if (current.idempotency_key === args.idempotencyKey) {
          return { error: new WorkspaceOperationIndeterminateError(current.kind ?? args.kind) };
        }
        recoveredOwner = current.owner;
      }

      const deadline = now + leaseMs;
      this.storage.sql.exec(
        `UPDATE ghostbuild_operation_lane
         SET owner = ?, idempotency_key = ?, kind = ?, acquired_at = ?, deadline = ?
         WHERE singleton = 1`,
        args.owner,
        args.idempotencyKey,
        args.kind,
        now,
        deadline,
      );
      return {
        owner: args.owner,
        idempotencyKey: args.idempotencyKey,
        kind: args.kind,
        acquiredAt: now,
        deadline,
        recoveredOwner,
      };
    });
    if ('error' in result) {
      throw result.error;
    }
    return result;
  }

  release(lease: WorkspaceOperationLease): void {
    this.storage.sql.exec(
      `UPDATE ghostbuild_operation_lane
       SET owner = NULL, idempotency_key = NULL, kind = NULL, acquired_at = NULL, deadline = NULL
       WHERE singleton = 1 AND owner = ?`,
      lease.owner,
    );
  }

  find(idempotencyKey: string, owner: string): WorkspaceOperationLease | null {
    const row = this.read();
    if (
      row.owner !== owner ||
      row.idempotency_key !== idempotencyKey ||
      row.kind === null ||
      row.acquired_at === null ||
      row.deadline === null
    ) {
      return null;
    }
    return {
      owner,
      idempotencyKey,
      kind: row.kind,
      acquiredAt: row.acquired_at,
      deadline: row.deadline,
      recoveredOwner: null,
    };
  }

  renew(lease: WorkspaceOperationLease, leaseMs: number, now = Date.now()): WorkspaceOperationLease {
    return this.storage.transactionSync(() => {
      const current = this.read();
      if (
        current.owner !== lease.owner ||
        current.idempotency_key !== lease.idempotencyKey ||
        current.deadline === null ||
        current.deadline <= now
      ) {
        throw new WorkspaceOperationIndeterminateError(lease.kind);
      }
      const renewed = { ...lease, deadline: now + leaseMs };
      this.storage.sql.exec(
        `UPDATE ghostbuild_operation_lane SET deadline = ?
         WHERE singleton = 1 AND owner = ? AND idempotency_key = ?`,
        renewed.deadline,
        lease.owner,
        lease.idempotencyKey,
      );
      return renewed;
    });
  }

  private read(): OperationLaneRow {
    return (
      first(
        this.storage.sql.exec<OperationLaneRow>(
          `SELECT owner, idempotency_key, kind, acquired_at, deadline
           FROM ghostbuild_operation_lane WHERE singleton = 1`,
        ),
      ) ?? {
        owner: null,
        idempotency_key: null,
        kind: null,
        acquired_at: null,
        deadline: null,
      }
    );
  }
}

function first<T>(rows: Iterable<T>): T | undefined {
  for (const row of rows) {
    return row;
  }
  return undefined;
}
