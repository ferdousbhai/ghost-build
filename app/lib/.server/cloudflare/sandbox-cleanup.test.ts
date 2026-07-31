import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getSandbox = vi.hoisted(() => vi.fn());
vi.mock('@cloudflare/sandbox', () => ({ getSandbox }));

import { destroyRegisteredSandbox, sweepSandboxCleanupCandidates, trackSandboxLifecycle } from './sandbox-cleanup';

const NOW = 1_750_000_000_000;

describe('durable sandbox cleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    getSandbox.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renews an active lease and removes its outbox record only after confirmed destruction', async () => {
    const database = cleanupDatabase();
    const sandbox = sandboxHandle();
    const lifecycle = await trackSandboxLifecycle({
      db: database.db,
      sandbox,
      sandboxId: 'build-1',
      operation: 'test build sandbox',
    });

    expect(candidate(database.sqlite, 'build-1')).toMatchObject({
      status: 'active',
      not_before: NOW + 3 * 60_000,
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(candidate(database.sqlite, 'build-1')).toMatchObject({
      status: 'active',
      not_before: NOW + 4 * 60_000,
    });

    await lifecycle.destroy();

    expect(sandbox.destroy).toHaveBeenCalledOnce();
    expect(candidate(database.sqlite, 'build-1')).toBeUndefined();
  });

  it('reclaims an expired lease after the originating Worker disappears', async () => {
    const database = cleanupDatabase();
    const original = sandboxHandle();
    const lifecycle = await trackSandboxLifecycle({
      db: database.db,
      sandbox: original,
      sandboxId: 'build-orphan',
      operation: 'orphaned validation sandbox',
    });
    lifecycle.stopHeartbeat();
    const reconciled = sandboxHandle();
    getSandbox.mockReturnValue(reconciled);

    await expect(
      sweepSandboxCleanupCandidates({ DB: database.db, DeploymentSandbox: {} } as never, { now: NOW + 3 * 60_000 }),
    ).resolves.toBe(1);

    expect(reconciled.destroy).toHaveBeenCalledOnce();
    expect(candidate(database.sqlite, 'build-orphan')).toBeUndefined();
  });

  it('keeps failed cleanup durable, disables keepAlive, and retries on the next sweep', async () => {
    const database = cleanupDatabase();
    database.sqlite
      .prepare(
        `INSERT INTO sandbox_cleanup_candidates
          (sandbox_id, lease_token, operation, status, not_before, created_at, updated_at, attempts)
         VALUES ('preview-orphan', 'lease-1', 'preview sandbox', 'cleanup', ?, ?, ?, 0)`,
      )
      .run(NOW, NOW, NOW);
    const unavailable = sandboxHandle();
    const destroyError = new Error('Durable Object reset');
    unavailable.destroy.mockRejectedValue(destroyError);
    getSandbox.mockReturnValue(unavailable);
    const firstSweep = sweepSandboxCleanupCandidates({ DB: database.db, DeploymentSandbox: {} } as never, { now: NOW });

    await vi.advanceTimersByTimeAsync(1_250);
    await expect(firstSweep).resolves.toBe(0);
    expect(unavailable.destroy).toHaveBeenCalledTimes(3);
    expect(unavailable.setKeepAlive).toHaveBeenCalledWith(false);
    expect(candidate(database.sqlite, 'preview-orphan')).toMatchObject({
      status: 'cleanup',
      not_before: NOW + 61_250,
      attempts: 1,
      last_error: 'Durable Object reset',
    });

    const recovered = sandboxHandle();
    getSandbox.mockReturnValue(recovered);
    await expect(
      sweepSandboxCleanupCandidates({ DB: database.db, DeploymentSandbox: {} } as never, { now: NOW + 61_250 }),
    ).resolves.toBe(1);
    expect(candidate(database.sqlite, 'preview-orphan')).toBeUndefined();
  });

  it('queues an unregistered sandbox before attempting manual destruction', async () => {
    const database = cleanupDatabase();
    const unavailable = sandboxHandle();
    unavailable.destroy.mockRejectedValue(new Error('container API unavailable'));
    getSandbox.mockReturnValue(unavailable);
    const cleanup = destroyRegisteredSandbox(
      { DB: database.db, DeploymentSandbox: {} } as never,
      'legacy-preview',
      'legacy preview sandbox',
    );

    await vi.advanceTimersByTimeAsync(1_250);
    await expect(cleanup).resolves.toBe(false);
    expect(candidate(database.sqlite, 'legacy-preview')).toMatchObject({
      status: 'cleanup',
      not_before: NOW + 61_250,
      attempts: 1,
      last_error: 'container API unavailable',
    });
  });
});

function sandboxHandle() {
  return {
    destroy: vi.fn().mockResolvedValue(undefined),
    setKeepAlive: vi.fn().mockResolvedValue(undefined),
  };
}

function candidate(sqlite: DatabaseSync, sandboxId: string) {
  return sqlite
    .prepare('SELECT status, not_before, attempts, last_error FROM sandbox_cleanup_candidates WHERE sandbox_id = ?')
    .get(sandboxId);
}

function cleanupDatabase(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE builder_preview_build_admissions (
      sandbox_id TEXT NOT NULL,
      status TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  sqlite.exec(readFileSync(new URL('../../../../migrations/0025_sandbox_cleanup_outbox.sql', import.meta.url), 'utf8'));
  const db = {
    prepare(query: string) {
      const statement = sqlite.prepare(query);
      let bindings: unknown[] = [];
      const prepared = {
        bind(...values: unknown[]) {
          bindings = values;
          return prepared;
        },
        async run() {
          const result = statement.run(...(bindings as []));
          return { success: true, meta: { changes: Number(result.changes) } } as D1Result;
        },
        async all<T>() {
          return { results: statement.all(...(bindings as [])) as T[] };
        },
      };
      return prepared;
    },
  } as unknown as D1Database;
  return { sqlite, db };
}
