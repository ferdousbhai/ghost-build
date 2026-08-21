import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  claimUserWorkspaceRuntimeProvisioning,
  findUserWorkspaceRuntime,
  markUserWorkspaceRuntimeError,
  markUserWorkspaceRuntimeReady,
  recordUserWorkspaceRuntimeUpgradeDeferral,
} from './user-workspace-runtime-repository';

describe('workspace runtime provisioning lease', () => {
  it('allows only one live provisioning attempt', async () => {
    const db = runtimeDatabase();

    await expect(claim(db, 'attempt-1', 100, 200)).resolves.toMatchObject({ claimed: true });
    await expect(claim(db, 'attempt-2', 150, 250)).resolves.toMatchObject({
      claimed: false,
      runtime: { status: 'provisioning', provisioningAttemptId: 'attempt-1' },
    });
  });

  it('prevents an expired attempt from overwriting its successful replacement', async () => {
    const db = runtimeDatabase();
    await claim(db, 'attempt-old', 100, 200);
    await expect(claim(db, 'attempt-new', 201, 400)).resolves.toMatchObject({ claimed: true });

    await markUserWorkspaceRuntimeReady({
      db,
      userId: 'user-1',
      connectionId: 'connection-1',
      connectionGeneration: 1,
      runtimeVersion: 'a'.repeat(64),
      attemptId: 'attempt-new',
      imageDigest: 'docker.io/base@sha256:test',
      now: 202,
    });
    await expect(
      markUserWorkspaceRuntimeError({
        db,
        userId: 'user-1',
        connectionId: 'connection-1',
        connectionGeneration: 1,
        runtimeVersion: 'a'.repeat(64),
        attemptId: 'attempt-old',
        error: 'late failure',
        now: 203,
      }),
    ).rejects.toThrow('connection changed');

    await expect(findUserWorkspaceRuntime(db, 'user-1')).resolves.toMatchObject({
      status: 'ready',
      lastError: null,
      provisioningAttemptId: null,
    });
  });

  it('keeps one deferral clock per pinned runtime and clears it once the upgrade is claimed', async () => {
    const db = runtimeDatabase();
    await claim(db, 'attempt-1', 100, 200);
    await markUserWorkspaceRuntimeReady({
      db,
      userId: 'user-1',
      connectionId: 'connection-1',
      connectionGeneration: 1,
      runtimeVersion: 'a'.repeat(64),
      attemptId: 'attempt-1',
      imageDigest: 'docker.io/base@sha256:test',
      now: 101,
    });

    const defer = (now: number) =>
      recordUserWorkspaceRuntimeUpgradeDeferral({ db, userId: 'user-1', runtimeVersion: 'a'.repeat(64), now });
    await expect(defer(1_000)).resolves.toBe(1_000);
    // A later deferral of the same pinned version measures from the first observation, not this one.
    await expect(defer(9_000)).resolves.toBe(1_000);

    await claimUserWorkspaceRuntimeProvisioning({
      db,
      userId: 'user-1',
      connectionId: 'connection-1',
      connectionGeneration: 1,
      workerName: 'ghostbuild-workspace-test',
      endpoint: 'https://workspace.example',
      runtimeVersion: 'b'.repeat(64),
      attemptId: 'attempt-2',
      leaseExpiresAt: 20_000,
      now: 10_000,
    });
    await expect(findUserWorkspaceRuntime(db, 'user-1')).resolves.toMatchObject({ upgradeDeferredSince: null });
  });

  it('leaves the deferral clock alone once the runtime it pinned is gone', async () => {
    const db = runtimeDatabase();
    await claim(db, 'attempt-1', 100, 200);

    await expect(
      recordUserWorkspaceRuntimeUpgradeDeferral({ db, userId: 'user-1', runtimeVersion: 'c'.repeat(64), now: 1_000 }),
    ).resolves.toBe(1_000);
    await expect(findUserWorkspaceRuntime(db, 'user-1')).resolves.toMatchObject({ upgradeDeferredSince: null });
  });

  it('adopts an exact claim when D1 commits before acknowledgement fails', async () => {
    const db = runtimeDatabase({ claimErrorAfterCommit: new Error('D1 acknowledgement lost') });

    await expect(claim(db, 'attempt-1', 100, 200)).resolves.toMatchObject({
      claimed: true,
      runtime: { status: 'provisioning', provisioningAttemptId: 'attempt-1' },
    });
  });
});

function claim(db: D1Database, attemptId: string, now: number, leaseExpiresAt: number) {
  return claimUserWorkspaceRuntimeProvisioning({
    db,
    userId: 'user-1',
    connectionId: 'connection-1',
    connectionGeneration: 1,
    workerName: 'ghostbuild-workspace-test',
    endpoint: 'https://workspace.example',
    runtimeVersion: 'a'.repeat(64),
    attemptId,
    leaseExpiresAt,
    now,
  });
}

function runtimeDatabase(options: { claimErrorAfterCommit?: Error } = {}): D1Database {
  const database = new DatabaseSync(':memory:');
  let failClaim = options.claimErrorAfterCommit;
  database.exec(`
    CREATE TABLE user_computer_runtimes (
      user_id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      connection_generation INTEGER NOT NULL,
      worker_name TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      runtime_version TEXT NOT NULL,
      status TEXT NOT NULL,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      provisioning_attempt_id TEXT,
      provisioning_lease_expires_at INTEGER,
      upgrade_deferred_since INTEGER,
      image_digest TEXT
    );
  `);
  return {
    prepare(query: string) {
      return prepared(database.prepare(query), () => {
        if (query.includes('INSERT INTO user_computer_runtimes') && failClaim) {
          const error = failClaim;
          failClaim = undefined;
          throw error;
        }
      });
    },
  } as unknown as D1Database;
}

function prepared(statement: StatementSync, afterFirst: () => void) {
  let values: SQLInputValue[] = [];
  return {
    bind(...next: SQLInputValue[]) {
      values = next;
      return this;
    },
    async first<T>() {
      const row = (statement.get(...values) as T | undefined) ?? null;
      afterFirst();
      return row;
    },
  };
}
