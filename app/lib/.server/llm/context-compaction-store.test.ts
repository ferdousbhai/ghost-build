import type { SqlProvider } from 'agents/experimental/memory/session';
import { describe, expect, test } from 'vitest';
import { DurableObjectContextCompactionRepository } from './context-compaction-store';

type Row = {
  summary: string | null;
  from_message_id: string | null;
  to_message_id: string | null;
  generation: number;
  last_attempt_tokens: number;
  last_attempt_message_count: number;
  last_result_tokens: number;
  last_attempt_status: 'idle' | 'running' | 'compacted' | 'noop' | 'error';
  last_error: string | null;
  updated_at: string;
};

class TestSqlProvider implements SqlProvider {
  readonly rows = new Map<string, Row>();

  sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[] {
    const query = strings.join('?').replace(/\s+/g, ' ').trim();
    if (query.startsWith('CREATE TABLE IF NOT EXISTS builder_context_state')) {
      return [];
    }
    if (query.startsWith('INSERT OR IGNORE INTO builder_context_state')) {
      this.rows.set('active', this.rows.get('active') ?? emptyRow(String(values.at(-1))));
      return [];
    }
    if (query.startsWith('SELECT summary')) {
      const row = this.rows.get(String(values[0]));
      return (row ? [row] : []) as T[];
    }
    if (query.startsWith('INSERT INTO builder_context_state')) {
      const [scope, summary, from, to, generation, tokens, count, resultTokens] = values;
      this.rows.set(String(scope), {
        summary: summary === null ? null : String(summary),
        from_message_id: from === null ? null : String(from),
        to_message_id: to === null ? null : String(to),
        generation: Number(generation),
        last_attempt_tokens: Number(tokens),
        last_attempt_message_count: Number(count),
        last_result_tokens: Number(resultTokens),
        last_attempt_status: query.includes("'compacted', NULL") ? 'compacted' : 'idle',
        last_error: null,
        updated_at: String(values.at(-1)),
      });
      return [];
    }
    throw new Error(`Unhandled test SQL: ${query}`);
  }
}

function emptyRow(updatedAt: string): Row {
  return {
    summary: null,
    from_message_id: null,
    to_message_id: null,
    generation: 0,
    last_attempt_tokens: 0,
    last_attempt_message_count: 0,
    last_result_tokens: 0,
    last_attempt_status: 'idle',
    last_error: null,
    updated_at: updatedAt,
  };
}

describe('DurableObjectContextCompactionRepository', () => {
  test('round-trips summary-only compaction state', () => {
    const repository = new DurableObjectContextCompactionRepository(new TestSqlProvider());
    repository.initialize();
    repository.saveCompaction(
      'subchat:2',
      { summary: 'summary', fromMessageId: 'm-3', toMessageId: 'm-9', generation: 4 },
      { attemptedTokens: 120_000, attemptedMessageCount: 30, resultTokens: 20_000 },
    );

    expect(repository.getState('subchat:2').compaction).toEqual({
      summary: 'summary',
      fromMessageId: 'm-3',
      toMessageId: 'm-9',
      generation: 4,
    });
  });
});
