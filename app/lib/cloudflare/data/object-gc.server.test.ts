import { beforeEach, describe, expect, test, vi } from 'vitest';
import { OBJECT_GC_GRACE_PERIOD_MS, OBJECT_GC_SWEEP_LIMIT, sweepObjectGcCandidates } from './object-gc.server';
import { deleteObject } from './object-storage.server';

vi.mock('./object-storage.server', () => ({ deleteObject: vi.fn() }));

const deleteObjectMock = vi.mocked(deleteObject);

describe('deferred R2 object collection', () => {
  beforeEach(() => {
    deleteObjectMock.mockReset();
  });

  test('deletes a due unreferenced object and removes its candidate', async () => {
    const database = new ObjectGcDatabase([{ storage_key: 'orphan', not_before: 10, attempts: 0 }]);

    await expect(sweepObjectGcCandidates(database.env, { now: 20 })).resolves.toBe(1);

    expect(deleteObjectMock).toHaveBeenCalledWith(database.env, 'orphan');
    expect(database.candidates).toEqual([]);
  });

  test('retains a referenced object while removing the stale candidate', async () => {
    const database = new ObjectGcDatabase([{ storage_key: 'live', not_before: 10, attempts: 0 }]);
    database.references.add('live');

    await expect(sweepObjectGcCandidates(database.env, { now: 20 })).resolves.toBe(0);

    expect(deleteObjectMock).not.toHaveBeenCalled();
    expect(database.candidates).toEqual([]);
  });

  test('reschedules a failed R2 deletion with an incremented attempt count', async () => {
    const database = new ObjectGcDatabase([{ storage_key: 'retry', not_before: 10, attempts: 2 }]);
    deleteObjectMock.mockRejectedValue(new Error('R2 unavailable'));

    await expect(sweepObjectGcCandidates(database.env, { now: 20 })).resolves.toBe(0);

    expect(database.candidates).toEqual([
      { storage_key: 'retry', not_before: 20 + OBJECT_GC_GRACE_PERIOD_MS, attempts: 3 },
    ]);
  });

  test('caps each opportunistic sweep to the bounded limit', async () => {
    const database = new ObjectGcDatabase(
      Array.from({ length: OBJECT_GC_SWEEP_LIMIT + 3 }, (_, index) => ({
        storage_key: `orphan-${index}`,
        not_before: 10,
        attempts: 0,
      })),
    );

    await expect(sweepObjectGcCandidates(database.env, { now: 20, limit: 999 })).resolves.toBe(OBJECT_GC_SWEEP_LIMIT);

    expect(deleteObjectMock).toHaveBeenCalledTimes(OBJECT_GC_SWEEP_LIMIT);
    expect(database.candidates).toHaveLength(3);
  });
});

type Candidate = {
  storage_key: string;
  not_before: number;
  attempts: number;
};

class ObjectGcDatabase {
  candidates: Candidate[];
  references = new Set<string>();

  constructor(candidates: Candidate[]) {
    this.candidates = candidates;
  }

  readonly db = {
    prepare: (query: string) => ({
      bind: (...values: unknown[]) => ({
        all: async () => this.all(query, values),
        first: async () => this.first(query, values),
        run: async () => this.run(query, values),
      }),
    }),
  } as unknown as D1Database;

  readonly env = { DB: this.db, APP_STORAGE: {} } as Pick<Env, 'APP_STORAGE' | 'DB'>;

  private all(query: string, values: unknown[]) {
    if (!query.includes('FROM object_gc_candidates')) {
      return { results: [] };
    }
    const now = values[0] as number;
    const limit = values[1] as number;
    return {
      results: this.candidates
        .filter((candidate) => candidate.not_before <= now)
        .sort((left, right) => left.not_before - right.not_before || left.storage_key.localeCompare(right.storage_key))
        .slice(0, limit)
        .map((candidate) => ({ storage_key: candidate.storage_key, not_before: candidate.not_before })),
    };
  }

  private first(query: string, values: unknown[]) {
    if (query.includes('FROM chat_message_states')) {
      return this.references.has(values[0] as string) ? { found: 1 } : null;
    }
    return null;
  }

  private run(query: string, values: unknown[]) {
    if (query.includes('DELETE FROM object_gc_candidates')) {
      const [key, notBefore, now] = values as [string, number, number];
      this.candidates = this.candidates.filter(
        (candidate) =>
          !(candidate.storage_key === key && candidate.not_before === notBefore && candidate.not_before <= now),
      );
    } else if (query.includes('UPDATE object_gc_candidates')) {
      const [retryAt, key, notBefore, now] = values as [number, string, number, number];
      const candidate = this.candidates.find(
        (item) => item.storage_key === key && item.not_before === notBefore && item.not_before <= now,
      );
      if (candidate) {
        candidate.attempts++;
        candidate.not_before = retryAt;
      }
    }
    return changed(1);
  }
}

function changed(changes: number) {
  return { success: true, meta: { changes } };
}
