import { describe, expect, it } from 'vitest';
import { ToolOperationJournal } from './tool-operation-journal';

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
