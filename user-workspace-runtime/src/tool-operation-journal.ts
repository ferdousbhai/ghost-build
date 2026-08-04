const MAX_PERSISTED_TOOL_OPERATIONS = 500;
const MAX_INDETERMINATE_TOOL_OPERATIONS = 50;
const MAX_TOOL_RESULT_BYTES = 512 * 1024;
const MAX_TOOL_ERROR_LENGTH = 4_000;

import { acknowledgeMutationReceipt, isMutationReceipt, type MutationReceipt } from './mutation-receipt';

type ToolOperationStorage = Pick<DurableObjectStorage, 'sql' | 'transactionSync'>;

type ToolOperationRow = {
  tool_name: string;
  args_sha256: string;
  status: 'running' | 'completed' | 'failed';
  result_json: string | null;
  error: string | null;
};

type PendingToolOperationRow = {
  tool_call_id: string;
  result_json: string;
};

type PendingCommandEnvelope = {
  kind: 'workspace-sync-pending';
  backend: string;
  result: unknown;
};

type PendingToolOperation = {
  backend: string;
  toolCallId: string;
  result: unknown;
};

export type ToolOperationStartResult =
  | { status: 'execute' }
  | { status: 'completed'; result: unknown }
  | { status: 'failed'; error: string }
  | { status: 'indeterminate'; error: string };

export class ToolOperationJournal {
  constructor(private readonly storage: ToolOperationStorage) {}

  initialize(): void {
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ghostbuild_tool_operations (
         tool_call_id TEXT PRIMARY KEY,
         tool_name TEXT NOT NULL,
         args_sha256 TEXT NOT NULL,
         status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
         result_json TEXT,
         error TEXT,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
    );
  }

  begin(args: { toolCallId: string; toolName: string; argsSha256: string; now?: number }): ToolOperationStartResult {
    return this.storage.transactionSync(() => {
      const existing = this.read(args.toolCallId);
      if (existing) {
        assertSameInvocation(existing, args);
        return startResult(existing);
      }
      const running = first(
        this.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count
           FROM ghostbuild_tool_operations
           WHERE status = 'running'`,
        ),
      )?.count;
      if ((running ?? 0) >= MAX_INDETERMINATE_TOOL_OPERATIONS) {
        throw new Error('The workspace has too many indeterminate tool operations to safely start another.');
      }
      const now = args.now ?? Date.now();
      this.storage.sql.exec(
        `INSERT INTO ghostbuild_tool_operations (
           tool_call_id, tool_name, args_sha256, status, result_json, error, created_at, updated_at
         ) VALUES (?, ?, ?, 'running', NULL, NULL, ?, ?)`,
        args.toolCallId,
        args.toolName,
        args.argsSha256,
        now,
        now,
      );
      this.storage.sql.exec(
        `DELETE FROM ghostbuild_tool_operations
         WHERE tool_call_id IN (
           SELECT tool_call_id
           FROM ghostbuild_tool_operations
           WHERE status != 'running'
           ORDER BY updated_at DESC, tool_call_id DESC
           LIMIT -1 OFFSET ?
         )`,
        MAX_PERSISTED_TOOL_OPERATIONS,
      );
      return { status: 'execute' };
    });
  }

  complete(args: { toolCallId: string; result: unknown; now?: number }): unknown {
    const resultJson = encodeResult(args.result);
    return this.storage.transactionSync(() => {
      const existing = this.require(args.toolCallId);
      if (existing.status === 'completed') {
        if (existing.result_json !== resultJson) {
          throw new Error('A completed workspace tool operation received a different result.');
        }
        return JSON.parse(existing.result_json);
      }
      if (existing.status === 'failed') {
        throw new Error(existing.error ?? 'The workspace tool operation failed.');
      }
      this.storage.sql.exec(
        `UPDATE ghostbuild_tool_operations
         SET status = 'completed', result_json = ?, error = NULL, updated_at = ?
         WHERE tool_call_id = ? AND status = 'running'`,
        resultJson,
        args.now ?? Date.now(),
        args.toolCallId,
      );
      return JSON.parse(resultJson) as unknown;
    });
  }

  commitMutation(args: { toolCallId: string; receipt: MutationReceipt; now?: number }): MutationReceipt {
    return this.complete({ toolCallId: args.toolCallId, result: args.receipt, now: args.now }) as MutationReceipt;
  }

  acknowledgeMutation(args: { toolCallId: string; result: unknown; now?: number }): MutationReceipt {
    return this.storage.transactionSync(() => {
      const existing = this.require(args.toolCallId);
      if (existing.status !== 'completed' || existing.result_json === null) {
        throw new Error('The workspace mutation was not durably committed.');
      }
      const receipt: unknown = JSON.parse(existing.result_json);
      if (!isMutationReceipt(receipt)) {
        throw new Error('The completed workspace operation is not a mutation receipt.');
      }
      if (receipt.acknowledgement === 'complete') {
        return receipt;
      }
      const acknowledged = acknowledgeMutationReceipt(receipt, args.result);
      const resultJson = JSON.stringify(acknowledged);
      this.storage.sql.exec(
        `UPDATE ghostbuild_tool_operations
         SET result_json = ?, updated_at = ?
         WHERE tool_call_id = ? AND status = 'completed'`,
        resultJson,
        args.now ?? Date.now(),
        args.toolCallId,
      );
      return acknowledged;
    });
  }

  toolName(toolCallId: string): string {
    return this.require(toolCallId).tool_name;
  }

  mutationReceipt(toolCallId: string): MutationReceipt | null {
    const existing = this.require(toolCallId);
    if (existing.status !== 'completed' || existing.result_json === null) {
      return null;
    }
    const result: unknown = JSON.parse(existing.result_json);
    return isMutationReceipt(result) ? result : null;
  }

  registerPending(args: { backend: string; toolCallId: string; result: unknown; now?: number }): void {
    const resultJson = encodeResult({
      kind: 'workspace-sync-pending',
      backend: args.backend,
      result: args.result,
    } satisfies PendingCommandEnvelope);
    this.storage.transactionSync(() => {
      const operation = this.require(args.toolCallId);
      if (operation.status !== 'running') {
        throw new Error('Only a running workspace tool operation can wait for synchronization.');
      }
      const existing = this.pending().find((pending) => pending.backend === args.backend);
      if (existing && (existing.toolCallId !== args.toolCallId || operation.result_json !== resultJson)) {
        throw new Error('A Computer backend already has a different pending tool operation.');
      }
      this.storage.sql.exec(
        `UPDATE ghostbuild_tool_operations
         SET result_json = ?, updated_at = ?
         WHERE tool_call_id = ? AND status = 'running'`,
        resultJson,
        args.now ?? Date.now(),
        args.toolCallId,
      );
    });
  }

  pending(): PendingToolOperation[] {
    return [
      ...this.storage.sql.exec<PendingToolOperationRow>(
        `SELECT tool_call_id, result_json
       FROM ghostbuild_tool_operations
       WHERE status = 'running' AND result_json IS NOT NULL
       ORDER BY tool_call_id`,
      ),
    ].map((row) => {
      const envelope = pendingEnvelope(row.result_json);
      if (!envelope) {
        throw new Error('A pending workspace tool operation has invalid recovery state.');
      }
      return { backend: envelope.backend, toolCallId: row.tool_call_id, result: envelope.result };
    });
  }

  completePending(backend: string, overrideResult?: unknown): boolean {
    return this.storage.transactionSync(() => {
      const pending = this.pending().find((operation) => operation.backend === backend);
      if (!pending) {
        return false;
      }
      const resultJson = encodeResult(overrideResult === undefined ? pending.result : overrideResult);
      this.storage.sql.exec(
        `UPDATE ghostbuild_tool_operations
         SET status = 'completed', result_json = ?, error = NULL, updated_at = ?
         WHERE tool_call_id = ? AND status = 'running'`,
        resultJson,
        Date.now(),
        pending.toolCallId,
      );
      return true;
    });
  }

  fail(args: { toolCallId: string; error: string; now?: number }): void {
    this.storage.transactionSync(() => {
      const existing = this.require(args.toolCallId);
      if (existing.status !== 'running') {
        return;
      }
      this.storage.sql.exec(
        `UPDATE ghostbuild_tool_operations
         SET status = 'failed', result_json = NULL, error = ?, updated_at = ?
         WHERE tool_call_id = ? AND status = 'running'`,
        args.error.slice(-MAX_TOOL_ERROR_LENGTH),
        args.now ?? Date.now(),
        args.toolCallId,
      );
    });
  }

  private require(toolCallId: string): ToolOperationRow {
    const row = this.read(toolCallId);
    if (!row) {
      throw new Error('The workspace tool operation was not started.');
    }
    return row;
  }

  private read(toolCallId: string): ToolOperationRow | undefined {
    return first(
      this.storage.sql.exec<ToolOperationRow>(
        `SELECT tool_name, args_sha256, status, result_json, error
         FROM ghostbuild_tool_operations
         WHERE tool_call_id = ?`,
        toolCallId,
      ),
    );
  }
}

function assertSameInvocation(row: ToolOperationRow, invocation: { toolName: string; argsSha256: string }): void {
  if (row.tool_name !== invocation.toolName || row.args_sha256 !== invocation.argsSha256) {
    throw new Error('A workspace tool-call identifier was reused with different arguments.');
  }
}

function startResult(row: ToolOperationRow): ToolOperationStartResult {
  if (row.status === 'completed' && row.result_json !== null) {
    return { status: 'completed', result: JSON.parse(row.result_json) };
  }
  if (row.status === 'failed') {
    return { status: 'failed', error: row.error ?? 'The workspace tool operation failed.' };
  }
  return {
    status: 'indeterminate',
    error: 'The workspace tool operation was interrupted after it started and will not be repeated automatically.',
  };
}

function pendingEnvelope(resultJson: string): PendingCommandEnvelope | null {
  const value: unknown = JSON.parse(resultJson);
  return typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'workspace-sync-pending' &&
    'backend' in value &&
    typeof value.backend === 'string' &&
    'result' in value
    ? (value as PendingCommandEnvelope)
    : null;
}

function encodeResult(result: unknown): string {
  const resultJson = JSON.stringify(result);
  if (resultJson === undefined || new TextEncoder().encode(resultJson).byteLength > MAX_TOOL_RESULT_BYTES) {
    throw new Error('The workspace tool result exceeded its durable result limit.');
  }
  return resultJson;
}

function first<T>(rows: Iterable<T>): T | undefined {
  for (const row of rows) {
    return row;
  }
  return undefined;
}
