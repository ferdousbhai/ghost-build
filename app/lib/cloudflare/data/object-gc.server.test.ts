import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  cancelObjectGcCandidate,
  DEPLOYMENT_BUILD_ARTIFACT_LEASE_MS,
  OBJECT_GC_GRACE_PERIOD_MS,
  OBJECT_GC_SWEEP_LIMIT,
  sweepObjectGcCandidates,
} from './object-gc.server';
import { deleteObject } from './object-storage.server';

vi.mock('./object-storage.server', () => ({ deleteObject: vi.fn() }));

const deleteObjectMock = vi.mocked(deleteObject);

describe('deferred R2 object collection', () => {
  beforeEach(() => {
    deleteObjectMock.mockReset();
  });

  test('deletes a due unreferenced object and removes its candidate', async () => {
    const database = new ObjectGcDatabase([{ storage_key: 'orphan', not_before: 10, attempts: 0 }]);
    database.accountedObjects.add('orphan');

    await expect(sweepObjectGcCandidates(database.env, { now: 20 })).resolves.toBe(1);

    expect(deleteObjectMock).toHaveBeenCalledWith(database.env, 'orphan');
    expect(database.candidates).toEqual([]);
    expect(database.accountedObjects).not.toContain('orphan');
  });

  test('retains a referenced object while removing the stale candidate', async () => {
    const database = new ObjectGcDatabase([{ storage_key: 'live', not_before: 10, attempts: 0 }]);
    database.references.add('live');

    await expect(sweepObjectGcCandidates(database.env, { now: 20 })).resolves.toBe(0);

    expect(deleteObjectMock).not.toHaveBeenCalled();
    expect(database.candidates).toEqual([]);
  });

  test('treats a deployment source snapshot as a live R2 reference', async () => {
    const database = new ObjectGcDatabase([{ storage_key: 'deployment-snapshot', not_before: 10, attempts: 0 }]);
    database.references.add('deployment-snapshot');

    await expect(sweepObjectGcCandidates(database.env, { now: 20 })).resolves.toBe(0);

    expect(database.referenceQueries.at(-1)).toContain('FROM deployments WHERE snapshot_key = ?');
    expect(deleteObjectMock).not.toHaveBeenCalled();
    expect(database.candidates).toEqual([]);
  });

  test('retains a fresh exact-generation build artifact lease but collects it after a hard stop', async () => {
    const database = new ObjectGcDatabase([{ storage_key: 'deployment-build', not_before: 10, attempts: 0 }]);
    database.buildArtifactReferences.set('deployment-build', {
      status: 'provisioning',
      updatedAt: 20,
      artifactGeneration: 3,
      executionGeneration: 3,
    });

    await expect(sweepObjectGcCandidates(database.env, { now: 20 })).resolves.toBe(0);

    expect(deleteObjectMock).not.toHaveBeenCalled();
    expect(database.candidates).toEqual([
      {
        storage_key: 'deployment-build',
        not_before: 20 + DEPLOYMENT_BUILD_ARTIFACT_LEASE_MS,
        attempts: 0,
      },
    ]);
    expect(database.referenceQueries.at(-1)).toContain('build_artifact_generation = execution_generation');

    await expect(
      sweepObjectGcCandidates(database.env, { now: 20 + DEPLOYMENT_BUILD_ARTIFACT_LEASE_MS + 1 }),
    ).resolves.toBe(1);
    expect(deleteObjectMock).toHaveBeenCalledWith(database.env, 'deployment-build');
    expect(database.candidates).toEqual([]);
  });

  test('does not treat a stale-generation build artifact key as live', async () => {
    const database = new ObjectGcDatabase([{ storage_key: 'old-build', not_before: 10, attempts: 0 }]);
    database.buildArtifactReferences.set('old-build', {
      status: 'provisioning',
      updatedAt: 20,
      artifactGeneration: 2,
      executionGeneration: 3,
    });

    await expect(sweepObjectGcCandidates(database.env, { now: 20 })).resolves.toBe(1);

    expect(deleteObjectMock).toHaveBeenCalledWith(database.env, 'old-build');
  });

  test('does not collect an object while its backup upload admission lease is live', async () => {
    const database = new ObjectGcDatabase([{ storage_key: 'uploading', not_before: 10, attempts: 0 }]);
    database.pendingAdmissionObjects.set('uploading', 30);

    await expect(sweepObjectGcCandidates(database.env, { now: 20 })).resolves.toBe(0);

    expect(deleteObjectMock).not.toHaveBeenCalled();
    expect(database.candidates).toEqual([{ storage_key: 'uploading', not_before: 30, attempts: 0 }]);
  });

  test('waits for explicit admission release instead of collecting solely from wall-clock expiry', async () => {
    const database = new ObjectGcDatabase([{ storage_key: 'abandoned', not_before: 10, attempts: 0 }]);
    database.pendingAdmissionObjects.set('abandoned', 19);

    await expect(sweepObjectGcCandidates(database.env, { now: 20 })).resolves.toBe(0);

    expect(deleteObjectMock).not.toHaveBeenCalled();
    expect(database.candidates).toEqual([
      { storage_key: 'abandoned', not_before: 20 + OBJECT_GC_GRACE_PERIOD_MS, attempts: 0 },
    ]);

    database.pendingAdmissionObjects.delete('abandoned');
    await expect(sweepObjectGcCandidates(database.env, { now: 20 + OBJECT_GC_GRACE_PERIOD_MS })).resolves.toBe(1);

    expect(deleteObjectMock).toHaveBeenCalledWith(database.env, 'abandoned');
  });

  test('does not cancel a candidate that was requeued after the caller received its cleanup receipt', async () => {
    const database = new ObjectGcDatabase([{ storage_key: 'snapshot', not_before: 20, attempts: 0 }]);

    await expect(cancelObjectGcCandidate(database.db, { storageKey: 'snapshot', notBefore: 10 })).resolves.toBe(false);
    expect(database.candidates).toEqual([{ storage_key: 'snapshot', not_before: 20, attempts: 0 }]);

    await expect(cancelObjectGcCandidate(database.db, { storageKey: 'snapshot', notBefore: 20 })).resolves.toBe(true);
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
  accountedObjects = new Set<string>();
  pendingAdmissionObjects = new Map<string, number>();
  references = new Set<string>();
  buildArtifactReferences = new Map<
    string,
    {
      status: string;
      updatedAt: number;
      artifactGeneration: number;
      executionGeneration: number;
    }
  >();
  referenceQueries: string[] = [];

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
    batch: async (statements: D1PreparedStatement[]) => {
      const results = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      return results;
    },
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
    if (query.includes('build_artifact_key')) {
      this.referenceQueries.push(query);
      const reference = this.buildArtifactReferences.get(values[0] as string);
      if (
        !reference ||
        reference.artifactGeneration !== reference.executionGeneration ||
        !['provisioning', 'building', 'deploying'].includes(reference.status)
      ) {
        return null;
      }
      return { updated_at: reference.updatedAt };
    }
    if (query.includes('FROM chat_backup_object_attributions')) {
      const expiresAt = this.pendingAdmissionObjects.get(values[0] as string);
      return expiresAt === undefined ? null : { expires_at: expiresAt };
    }
    if (query.includes('FROM chat_message_states')) {
      this.referenceQueries.push(query);
      return this.references.has(values[0] as string) ? { found: 1 } : null;
    }
    return null;
  }

  private run(query: string, values: unknown[]) {
    if (query.includes('DELETE FROM chat_backup_objects')) {
      const [key, candidateKey, notBefore, now] = values as [string, string, number, number];
      const candidate = this.candidates.find(
        (item) => item.storage_key === candidateKey && item.not_before === notBefore && item.not_before <= now,
      );
      const changedRows = candidate && this.accountedObjects.delete(key) ? 1 : 0;
      return changed(changedRows);
    } else if (query.includes('DELETE FROM object_gc_candidates')) {
      const before = this.candidates.length;
      if (values.length === 2) {
        const [key, notBefore] = values as [string, number];
        this.candidates = this.candidates.filter(
          (candidate) => !(candidate.storage_key === key && candidate.not_before === notBefore),
        );
        return changed(before - this.candidates.length);
      }
      const [key, notBefore, now] = values as [string, number, number];
      this.candidates = this.candidates.filter(
        (candidate) =>
          !(candidate.storage_key === key && candidate.not_before === notBefore && candidate.not_before <= now),
      );
      return changed(before - this.candidates.length);
    } else if (query.includes('attempts = attempts + 1')) {
      const [retryAt, key, notBefore, now] = values as [number, string, number, number];
      const candidate = this.candidates.find(
        (item) => item.storage_key === key && item.not_before === notBefore && item.not_before <= now,
      );
      if (candidate) {
        candidate.attempts++;
        candidate.not_before = retryAt;
      }
    } else if (query.includes('UPDATE object_gc_candidates')) {
      const [leaseUntil, key, notBefore, now] = values as [number, string, number, number];
      const candidate = this.candidates.find(
        (item) => item.storage_key === key && item.not_before === notBefore && item.not_before <= now,
      );
      if (candidate) {
        candidate.not_before = leaseUntil;
      }
    }
    return changed(1);
  }
}

function changed(changes: number) {
  return { success: true, meta: { changes } };
}
