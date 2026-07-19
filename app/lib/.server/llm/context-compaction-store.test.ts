import type { SqlProvider } from 'agents/experimental/memory/session';
import { describe, expect, test } from 'vitest';
import { DurableObjectContextCompactionRepository } from './context-compaction-store';

type Row = {
  summary: string | null;
  from_message_id: string | null;
  to_message_id: string | null;
};

class TestSqlProvider implements SqlProvider {
  readonly rows = new Map<string, Row>();

  sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[] {
    const query = strings.join('?').replace(/\s+/g, ' ').trim();
    if (query.startsWith('SELECT summary')) {
      const row = this.rows.get(String(values[0]));
      return (row ? [row] : []) as T[];
    }
    if (query.startsWith('INSERT INTO builder_context_state')) {
      const [id, summary, from, to] = values;
      this.rows.set(String(id), {
        summary: summary === null ? null : String(summary),
        from_message_id: from === null ? null : String(from),
        to_message_id: to === null ? null : String(to),
      });
      return [];
    }
    if (query.startsWith('DELETE FROM builder_context_state')) {
      this.rows.delete(String(values[0]));
      return [];
    }
    throw new Error(`Unhandled test SQL: ${query}`);
  }
}

describe('DurableObjectContextCompactionRepository', () => {
  test('does not write an empty record when read before a compaction exists', () => {
    const db = new TestSqlProvider();
    const repository = new DurableObjectContextCompactionRepository(db);

    expect(db.rows.size).toBe(0);
    expect(repository.getCompaction()).toBeNull();
  });

  test('round-trips the Agent-owned summary overlay', () => {
    const repository = new DurableObjectContextCompactionRepository(new TestSqlProvider());
    repository.saveCompaction({
      summary: 'summary',
      fromMessageId: 'm-3',
      toMessageId: 'm-9',
    });

    expect(repository.getCompaction()).toEqual({
      summary: 'summary',
      fromMessageId: 'm-3',
      toMessageId: 'm-9',
    });
  });

  test('lazily moves a deployed scoped summary to the canonical Agent record', () => {
    const db = new TestSqlProvider();
    db.rows.set('active', {
      summary: 'older summary',
      from_message_id: 'm-1',
      to_message_id: 'm-3',
    });
    db.rows.set('subchat:2', {
      summary: 'legacy summary',
      from_message_id: 'm-1',
      to_message_id: 'm-5',
    });
    const repository = new DurableObjectContextCompactionRepository(db);

    repository.migrateLegacySubchat(2);

    expect(repository.getCompaction()).toEqual({
      summary: 'legacy summary',
      fromMessageId: 'm-1',
      toMessageId: 'm-5',
    });
    expect(db.rows.has('subchat:2')).toBe(false);
  });
});
