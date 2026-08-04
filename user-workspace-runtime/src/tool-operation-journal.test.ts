import { describe, expect, it } from 'vitest';
import { ToolOperationJournal } from './tool-operation-journal';
import { requireWorkspaceSyncBarrier, WorkspaceSyncPendingError } from './workspace-sync-retry';

describe('ToolOperationJournal', () => {
  it('replays the exact completed result without executing the operation again', () => {
    const storage = new TestStorage();
    const journal = new ToolOperationJournal(storage as never);
    journal.initialize();

    expect(journal.begin(invocation())).toEqual({ status: 'execute' });
    expect(
      journal.complete({ toolCallId: 'call-1', result: { path: '/home/project/a.ts', bytes: 12 }, now: 2 }),
    ).toEqual({
      path: '/home/project/a.ts',
      bytes: 12,
    });
    expect(journal.begin(invocation())).toEqual({
      status: 'completed',
      result: { path: '/home/project/a.ts', bytes: 12 },
    });
  });

  it('fails closed instead of repeating an operation interrupted after its durable start', () => {
    const journal = new ToolOperationJournal(new TestStorage() as never);
    journal.initialize();

    expect(journal.begin(invocation())).toEqual({ status: 'execute' });
    expect(journal.begin(invocation())).toEqual({
      status: 'indeterminate',
      error: 'The workspace tool operation was interrupted after it started and will not be repeated automatically.',
    });
  });

  it('bounds retained indeterminate operations without making them replayable', () => {
    const journal = new ToolOperationJournal(new TestStorage() as never);
    journal.initialize();

    for (let index = 0; index < 50; index++) {
      expect(
        journal.begin({
          toolCallId: `call-${index}`,
          toolName: 'exec',
          argsSha256: `sha-${index}`,
        }),
      ).toEqual({ status: 'execute' });
    }

    expect(() =>
      journal.begin({
        toolCallId: 'call-over-limit',
        toolName: 'exec',
        argsSha256: 'sha-over-limit',
      }),
    ).toThrow(/too many indeterminate tool operations/);

    expect(journal.begin({ toolCallId: 'call-0', toolName: 'exec', argsSha256: 'sha-0' })).toEqual({
      status: 'indeterminate',
      error: 'The workspace tool operation was interrupted after it started and will not be repeated automatically.',
    });
  });

  it('durably replays failures and rejects tool-call identifier reuse', () => {
    const journal = new ToolOperationJournal(new TestStorage() as never);
    journal.initialize();
    journal.begin(invocation());
    journal.fail({ toolCallId: 'call-1', error: 'command failed', now: 2 });

    expect(journal.begin(invocation())).toEqual({ status: 'failed', error: 'command failed' });
    expect(() => journal.begin({ ...invocation(), argsSha256: 'b'.repeat(64) })).toThrow(
      'reused with different arguments',
    );
    expect(() => journal.begin({ ...invocation(), toolName: 'exec' })).toThrow('reused with different arguments');
  });

  it('replays a bounded committed mutation when its large display acknowledgement is interrupted', () => {
    const journal = new ToolOperationJournal(new TestStorage() as never);
    journal.initialize();
    journal.begin(invocation());
    const receipt = {
      kind: 'workspace-mutation-receipt' as const,
      version: 1 as const,
      committed: true as const,
      acknowledgement: 'pending' as const,
      tool: 'write' as const,
      files: [
        {
          path: '/home/project/a.ts',
          revision: 2,
          size: 2 * 1024 * 1024 - 1,
          sha256: 'c'.repeat(64),
          deleted: false,
        },
      ],
      changedRanges: [{ path: '/home/project/a.ts', startLine: 1, endLine: 1 }],
      diffSummary: null,
      truncated: { result: false, diff: false, paths: false, omittedBytes: 0 },
    };

    journal.commitMutation({ toolCallId: 'call-1', receipt, now: 2 });

    expect(journal.begin(invocation())).toEqual({ status: 'completed', result: receipt });
    const acknowledged = journal.acknowledgeMutation({
      toolCallId: 'call-1',
      result: { diff: 'x'.repeat(700_000), patch: 'y'.repeat(700_000) },
      now: 3,
    });
    expect(acknowledged).toMatchObject({
      committed: true,
      acknowledgement: 'complete',
      truncated: { result: true, diff: true },
    });
    expect(journal.begin(invocation())).toEqual({ status: 'completed', result: acknowledged });
  });

  it('distinguishes a mutation that failed before its first durable write', () => {
    const journal = new ToolOperationJournal(new TestStorage() as never);
    journal.initialize();
    journal.begin(invocation());

    expect(journal.mutationReceipt('call-1')).toBeNull();
    expect(journal.complete({ toolCallId: 'call-1', result: { error: 'path does not exist' } })).toEqual({
      error: 'path does not exist',
    });
    expect(journal.mutationReceipt('call-1')).toBeNull();
  });

  it('terminalizes more than fifty pending commands without consuming the indeterminate-operation budget', () => {
    const storage = new TestStorage();
    const journal = new ToolOperationJournal(storage as never);
    journal.initialize();

    for (let index = 0; index < 60; index += 1) {
      const toolCallId = `pending-${index}`;
      expect(journal.begin({ toolCallId, toolName: 'exec', argsSha256: `sha-${index}` })).toEqual({
        status: 'execute',
      });
      journal.registerPending({
        backend: 'container-shell',
        toolCallId,
        result: { command: `command-${index}`, exitCode: 0 },
      });
      expect(journal.completePending('container-shell')).toBe(true);
    }

    expect(journal.pending()).toEqual([]);
    expect(journal.begin({ toolCallId: 'after-pending', toolName: 'exec', argsSha256: 'after' })).toEqual({
      status: 'execute',
    });
  });

  it('replays completed and exhausted pending commands after restart without rerunning them', () => {
    const storage = new TestStorage();
    const beforeRestart = new ToolOperationJournal(storage as never);
    beforeRestart.initialize();
    beforeRestart.begin({ toolCallId: 'pending-complete', toolName: 'exec', argsSha256: 'complete' });
    beforeRestart.registerPending({
      backend: 'container-shell',
      toolCallId: 'pending-complete',
      result: { command: 'touch file', exitCode: 0 },
    });

    const afterRestart = new ToolOperationJournal(storage as never);
    afterRestart.initialize();
    expect(afterRestart.completePending('container-shell')).toBe(true);
    expect(afterRestart.begin({ toolCallId: 'pending-complete', toolName: 'exec', argsSha256: 'complete' })).toEqual({
      status: 'completed',
      result: { command: 'touch file', exitCode: 0 },
    });

    afterRestart.begin({ toolCallId: 'pending-exhausted', toolName: 'exec', argsSha256: 'exhausted' });
    afterRestart.registerPending({
      backend: 'worker-shell',
      toolCallId: 'pending-exhausted',
      result: { command: 'touch other', exitCode: 0 },
    });
    const exhausted = { kind: 'workspace-sync-unconfirmed', status: 'exhausted' };
    expect(afterRestart.completePending('worker-shell', exhausted)).toBe(true);
    expect(afterRestart.begin({ toolCallId: 'pending-exhausted', toolName: 'exec', argsSha256: 'exhausted' })).toEqual({
      status: 'completed',
      result: exhausted,
    });
  });

  it('blocks new work after restart when a pending continuation has no Computer retry row', () => {
    const storage = new TestStorage();
    const beforeRestart = new ToolOperationJournal(storage as never);
    beforeRestart.initialize();
    beforeRestart.begin({ toolCallId: 'pending-restart', toolName: 'exec', argsSha256: 'restart' });
    beforeRestart.registerPending({
      backend: 'container-shell',
      toolCallId: 'pending-restart',
      result: { command: 'touch file', exitCode: 0 },
    });

    const afterRestart = new ToolOperationJournal(storage as never);
    afterRestart.initialize();
    expect(() => requireWorkspaceSyncBarrier(afterRestart.pending(), () => null, 1_000)).toThrow(
      WorkspaceSyncPendingError,
    );
    try {
      requireWorkspaceSyncBarrier(afterRestart.pending(), () => null, 1_000);
    } catch (error) {
      expect(error).toMatchObject({
        code: 'workspace_sync_pending',
        backend: 'container-shell',
        attempt: 1,
        notBefore: 2_000,
      });
    }

    expect(afterRestart.completePending('container-shell')).toBe(true);
    expect(() => requireWorkspaceSyncBarrier(afterRestart.pending(), () => null, 1_000)).not.toThrow();
  });

  it('rejects corrupted pending recovery state instead of omitting the operation', () => {
    const storage = new TestStorage();
    const journal = new ToolOperationJournal(storage as never);
    journal.initialize();
    journal.begin({ toolCallId: 'pending-corrupt', toolName: 'exec', argsSha256: 'corrupt' });
    storage.rows.get('pending-corrupt')!.result_json = JSON.stringify({ kind: 'unknown' });

    expect(() => journal.pending()).toThrow('invalid recovery state');
  });
});

function invocation() {
  return { toolCallId: 'call-1', toolName: 'write', argsSha256: 'a'.repeat(64), now: 1 };
}

type Row = {
  tool_name: string;
  args_sha256: string;
  status: 'running' | 'completed' | 'failed';
  result_json: string | null;
  error: string | null;
  updated_at: number;
};

class TestStorage {
  readonly rows = new Map<string, Row>();
  readonly sql = {
    exec: <T>(query: string, ...bindings: unknown[]): T[] => {
      const normalized = query.replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('SELECT tool_name')) {
        const row = this.rows.get(String(bindings[0]));
        return (row ? [row] : []) as T[];
      }
      if (normalized.startsWith('SELECT COUNT(*)')) {
        return [{ count: [...this.rows.values()].filter((row) => row.status === 'running').length }] as T[];
      }
      if (normalized.startsWith('SELECT tool_call_id')) {
        return [...this.rows]
          .filter(([, row]) => row.status === 'running' && row.result_json !== null)
          .map(([tool_call_id, row]) => ({ tool_call_id, result_json: row.result_json })) as T[];
      }
      if (normalized.startsWith('INSERT INTO ghostbuild_tool_operations')) {
        this.rows.set(String(bindings[0]), {
          tool_name: String(bindings[1]),
          args_sha256: String(bindings[2]),
          status: 'running',
          result_json: null,
          error: null,
          updated_at: Number(bindings[4]),
        });
      } else if (normalized.includes("SET status = 'completed'")) {
        const row = this.rows.get(String(bindings[2]))!;
        this.rows.set(String(bindings[2]), {
          ...row,
          status: 'completed',
          result_json: String(bindings[0]),
          error: null,
          updated_at: Number(bindings[1]),
        });
      } else if (normalized.includes("SET status = 'failed'")) {
        const row = this.rows.get(String(bindings[2]))!;
        this.rows.set(String(bindings[2]), {
          ...row,
          status: 'failed',
          result_json: null,
          error: String(bindings[0]),
          updated_at: Number(bindings[1]),
        });
      } else if (normalized.includes('SET result_json = ?')) {
        const row = this.rows.get(String(bindings[2]))!;
        this.rows.set(String(bindings[2]), {
          ...row,
          result_json: String(bindings[0]),
          updated_at: Number(bindings[1]),
        });
      }
      return [];
    },
  };

  transactionSync<T>(closure: () => T): T {
    const snapshot = new Map(this.rows);
    try {
      return closure();
    } catch (error) {
      this.rows.clear();
      for (const [key, row] of snapshot) {
        this.rows.set(key, row);
      }
      throw error;
    }
  }
}
