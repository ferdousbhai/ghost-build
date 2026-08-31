import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { DatabaseSync as DatabaseSyncInstance, SQLInputValue } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runUserWorkspaceRuntimeReclamation,
  WORKSPACE_RUNTIME_ABANDONED_MS,
  type WorkspaceRuntimeReclaimApi,
} from './user-workspace-runtime-reclaim';
import {
  listOutstandingUserWorkspaceRuntimeResources,
  recordUserWorkspaceRuntimeResources,
} from './user-workspace-runtime-resources';

const NOW = 1_800_000_000_000;
const LONG_AGO = NOW - WORKSPACE_RUNTIME_ABANDONED_MS - 1;
const WORKER = 'ghostbuild-workspace-18e073433e6fad63';
const DATABASE = 'ghostbuild-data-18e073433e6fad63';

describe('abandoned workspace runtime reclamation', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('reports what an abandoned provisioning left behind without deleting any of it', async () => {
    const { database, db } = controlPlaneDatabase();
    seedAbandonedRuntime(database);
    await recordProvisionedResources(db);
    const api = reclaimApi();

    await expect(
      runUserWorkspaceRuntimeReclamation({ DB: db } as unknown as Env, { now: NOW, accountApi: api }),
    ).resolves.toEqual({
      candidates: 1,
      resources: 3,
      reclaimed: 0,
      retained: { unrecorded: 0, holds_user_data: 0, unreadable: 0 },
    });
    expect(api.deleteManagedWorker).not.toHaveBeenCalled();
    expect(api.deleteD1DatabaseById).not.toHaveBeenCalled();
    expect(rowCount(database, 'user_computer_runtimes')).toBe(1);
    warn.mockRestore();
  });

  it('reclaims the container, the Worker and the database, in that order, when enforcing', async () => {
    const { database, db } = controlPlaneDatabase();
    seedAbandonedRuntime(database);
    await recordProvisionedResources(db);
    const order: string[] = [];
    const api = reclaimApi({
      deleteWorkspaceRuntimeContainer: vi.fn(async () => void order.push('container')),
      deleteManagedWorker: vi.fn(async () => void order.push('worker')),
      deleteD1DatabaseById: vi.fn(async () => void order.push('d1')),
    });

    const summary = await runUserWorkspaceRuntimeReclamation({ DB: db } as unknown as Env, {
      now: NOW,
      mode: 'enforce',
      accountApi: api,
    });

    expect(summary).toEqual({
      candidates: 1,
      resources: 3,
      reclaimed: 3,
      retained: { unrecorded: 0, holds_user_data: 0, unreadable: 0 },
    });
    expect(order).toEqual(['container', 'worker', 'd1']);
    expect(api.deleteWorkspaceRuntimeContainer).toHaveBeenCalledWith(WORKER);
    expect(api.deleteManagedWorker).toHaveBeenCalledWith(WORKER);
    expect(api.deleteD1DatabaseById).toHaveBeenCalledWith('database-1');
    // The record survives reclamation; only the locator goes.
    await expect(listOutstandingUserWorkspaceRuntimeResources(db, 'user-1', 'account-1')).resolves.toEqual([]);
    expect(rowCount(database, 'user_workspace_runtime_resources')).toBe(3);
    expect(rowCount(database, 'user_computer_runtimes')).toBe(0);
    warn.mockRestore();
  });

  it('never deletes a database that still holds a workspace', async () => {
    const { database, db } = controlPlaneDatabase();
    seedAbandonedRuntime(database);
    await recordProvisionedResources(db);
    const api = reclaimApi({ workspaceDatabaseHoldsUserData: vi.fn(async () => true) });

    const summary = await runUserWorkspaceRuntimeReclamation({ DB: db } as unknown as Env, {
      now: NOW,
      mode: 'enforce',
      accountApi: api,
    });

    expect(summary.retained.holds_user_data).toBe(1);
    expect(summary.reclaimed).toBe(0);
    // The Worker is spared too: a workspace with data in it is not an abandoned provisioning.
    expect(api.deleteManagedWorker).not.toHaveBeenCalled();
    expect(rowCount(database, 'user_computer_runtimes')).toBe(1);
    warn.mockRestore();
  });

  it('reclaims nothing when it cannot read whether the database is empty', async () => {
    const { database, db } = controlPlaneDatabase();
    seedAbandonedRuntime(database);
    await recordProvisionedResources(db);
    const api = reclaimApi({
      workspaceDatabaseHoldsUserData: vi.fn(() =>
        Promise.reject(new Error('Cloudflare returned an unreadable row count.')),
      ),
    });

    const summary = await runUserWorkspaceRuntimeReclamation({ DB: db } as unknown as Env, {
      now: NOW,
      mode: 'enforce',
      accountApi: api,
    });

    expect(summary.retained.unreadable).toBe(1);
    expect(api.deleteManagedWorker).not.toHaveBeenCalled();
    expect(rowCount(database, 'user_computer_runtimes')).toBe(1);
    warn.mockRestore();
  });

  it('says so rather than guessing when a runtime predates the record', async () => {
    const { database, db } = controlPlaneDatabase();
    seedAbandonedRuntime(database);
    const api = reclaimApi();

    const summary = await runUserWorkspaceRuntimeReclamation({ DB: db } as unknown as Env, {
      now: NOW,
      mode: 'enforce',
      accountApi: api,
    });

    expect(summary).toEqual({
      candidates: 1,
      resources: 0,
      reclaimed: 0,
      retained: { unrecorded: 1, holds_user_data: 0, unreadable: 0 },
    });
    expect(api.findD1DatabaseId).not.toHaveBeenCalled();
    expect(rowCount(database, 'user_computer_runtimes')).toBe(1);
    warn.mockRestore();
  });

  it('resolves a database recorded before it was created, and skips one that never appeared', async () => {
    const { database, db } = controlPlaneDatabase();
    seedAbandonedRuntime(database);
    // Provisioning died between recording the intent and creating anything, so there is no id.
    await recordUserWorkspaceRuntimeResources({
      db,
      userId: 'user-1',
      accountId: 'account-1',
      resources: [
        { resourceType: 'd1', resourceName: DATABASE },
        { resourceType: 'worker', resourceName: WORKER },
        { resourceType: 'container', resourceName: WORKER },
      ],
      now: LONG_AGO,
    });
    const api = reclaimApi({ findD1DatabaseId: vi.fn(async () => null) });

    const summary = await runUserWorkspaceRuntimeReclamation({ DB: db } as unknown as Env, {
      now: NOW,
      mode: 'enforce',
      accountApi: api,
    });

    expect(api.findD1DatabaseId).toHaveBeenCalledWith(DATABASE);
    expect(api.workspaceDatabaseHoldsUserData).not.toHaveBeenCalled();
    expect(api.deleteD1DatabaseById).not.toHaveBeenCalled();
    expect(api.deleteManagedWorker).toHaveBeenCalledWith(WORKER);
    expect(summary.reclaimed).toBe(3);
    warn.mockRestore();
  });

  it('keeps the locator of a runtime someone came back to mid-reclaim', async () => {
    const { database, db } = controlPlaneDatabase();
    seedAbandonedRuntime(database);
    await recordProvisionedResources(db);
    const api = reclaimApi({
      // Standing in for a retry that claims the runtime while the account is being read.
      workspaceDatabaseHoldsUserData: vi.fn(async () => {
        database.exec(
          `UPDATE user_computer_runtimes SET status = 'provisioning', updated_at = ${NOW} WHERE user_id = 'user-1'`,
        );
        return false;
      }),
    });

    await runUserWorkspaceRuntimeReclamation({ DB: db } as unknown as Env, {
      now: NOW,
      mode: 'enforce',
      accountApi: api,
    });

    expect(rowCount(database, 'user_computer_runtimes')).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('changed while it was being reclaimed'),
    );
    warn.mockRestore();
  });

  it.each([
    ['a ready runtime', "UPDATE user_computer_runtimes SET status = 'ready'"],
    ['a failure that is still recent', `UPDATE user_computer_runtimes SET updated_at = ${NOW - 1000}`],
    [
      'a provisioning claim still under lease',
      `UPDATE user_computer_runtimes SET status = 'provisioning', provisioning_lease_expires_at = ${NOW + 1000}`,
    ],
  ])('leaves %s alone', async (_case, mutation) => {
    const { database, db } = controlPlaneDatabase();
    seedAbandonedRuntime(database);
    await recordProvisionedResources(db);
    database.exec(mutation);
    const api = reclaimApi();

    const summary = await runUserWorkspaceRuntimeReclamation({ DB: db } as unknown as Env, {
      now: NOW,
      mode: 'enforce',
      accountApi: api,
    });

    expect(summary.candidates).toBe(0);
    expect(api.deleteManagedWorker).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('the record of what workspace provisioning created', () => {
  it('adds a provider id to a name it already recorded, and never clears one', async () => {
    const { db } = controlPlaneDatabase();
    seedAbandonedRuntime(controlPlaneOf(db));

    await recordUserWorkspaceRuntimeResources({
      db,
      userId: 'user-1',
      accountId: 'account-1',
      resources: [{ resourceType: 'd1', resourceName: DATABASE }],
    });
    await recordUserWorkspaceRuntimeResources({
      db,
      userId: 'user-1',
      accountId: 'account-1',
      resources: [{ resourceType: 'd1', resourceName: DATABASE, providerResourceId: 'database-1' }],
    });
    // A retry adopts what is already there and records the same name again without an id.
    await recordUserWorkspaceRuntimeResources({
      db,
      userId: 'user-1',
      accountId: 'account-1',
      resources: [{ resourceType: 'd1', resourceName: DATABASE }],
    });

    await expect(listOutstandingUserWorkspaceRuntimeResources(db, 'user-1', 'account-1')).resolves.toEqual([
      { resourceType: 'd1', resourceName: DATABASE, providerResourceId: 'database-1' },
    ]);
  });
});

function reclaimApi(overrides: Partial<WorkspaceRuntimeReclaimApi> = {}): WorkspaceRuntimeReclaimApi {
  return Object.assign(
    {
      findD1DatabaseId: vi.fn<WorkspaceRuntimeReclaimApi['findD1DatabaseId']>(async () => 'database-1'),
      workspaceDatabaseHoldsUserData: vi.fn<WorkspaceRuntimeReclaimApi['workspaceDatabaseHoldsUserData']>(
        async () => false,
      ),
      deleteD1DatabaseById: vi.fn<WorkspaceRuntimeReclaimApi['deleteD1DatabaseById']>(async () => undefined),
      deleteManagedWorker: vi.fn<WorkspaceRuntimeReclaimApi['deleteManagedWorker']>(async () => undefined),
      deleteWorkspaceRuntimeContainer: vi.fn<WorkspaceRuntimeReclaimApi['deleteWorkspaceRuntimeContainer']>(
        async () => undefined,
      ),
    },
    overrides,
  );
}

function recordProvisionedResources(db: D1Database): Promise<void> {
  return recordUserWorkspaceRuntimeResources({
    db,
    userId: 'user-1',
    accountId: 'account-1',
    resources: [
      { resourceType: 'd1', resourceName: DATABASE, providerResourceId: 'database-1' },
      { resourceType: 'worker', resourceName: WORKER },
      { resourceType: 'container', resourceName: WORKER },
    ],
    now: LONG_AGO,
  });
}

function seedAbandonedRuntime(database: DatabaseSyncInstance): void {
  database
    .prepare(
      `INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt, cloudflare_subject)
       VALUES ('user-1', 'Test', 'user-1@example.test', 1, NULL, 1, 1, 'subject-1')`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO cloudflare_credentials (handle, ciphertext_base64, iv_base64, key_version, created_at)
       VALUES ('handle-1', 'ciphertext', 'iv', 1, 1)`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO cloudflare_connections
        (id, user_id, account_id, account_name, status, credential_handle, granted_capabilities_json,
         ai_billing_enabled, connected_at, created_at, updated_at)
       VALUES ('connection-1', 'user-1', 'account-1', 'Account', 'active', 'handle-1', '["workers"]', 1, 1, 1, 1)`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO user_computer_runtimes
        (user_id, connection_id, connection_generation, worker_name, endpoint, runtime_version, status,
         last_error, created_at, updated_at)
       VALUES ('user-1', 'connection-1', 1, ?, 'https://runtime.example', 'sha', 'error',
               'Cloudflare refused the upload.', ?, ?)`,
    )
    .run(WORKER, LONG_AGO, LONG_AGO);
}

const controlPlanes = new WeakMap<D1Database, DatabaseSyncInstance>();

function controlPlaneOf(db: D1Database): DatabaseSyncInstance {
  const database = controlPlanes.get(db);
  if (!database) {
    throw new Error('The control plane database was not created by this test harness.');
  }
  return database;
}

function controlPlaneDatabase(): { database: DatabaseSyncInstance; db: D1Database } {
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (location: string) => DatabaseSyncInstance;
  };
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON;');
  // The shipped migrations, so the record and the candidate query are proven against the real schema.
  for (const migration of readdirSync('migrations').sort()) {
    database.exec(readFileSync(join('migrations', migration), 'utf8'));
  }
  const db = {
    prepare(sql: string) {
      const statement = (values: unknown[]) => ({
        run: async () => {
          const result = database.prepare(sql).run(...(values as SQLInputValue[]));
          return { success: true, meta: { changes: Number(result.changes) } } as D1Result;
        },
        first: async () => database.prepare(sql).get(...(values as SQLInputValue[])) ?? null,
        all: async () => ({ success: true, results: database.prepare(sql).all(...(values as SQLInputValue[])) }),
      });
      return { ...statement([]), bind: (...values: unknown[]) => statement(values) };
    },
    batch: async (statements: D1PreparedStatement[]) => Promise.all(statements.map((statement) => statement.run())),
  } as unknown as D1Database;
  controlPlanes.set(db, database);
  return { database, db };
}

function rowCount(database: DatabaseSyncInstance, table: string): number {
  return Number((database.prepare(`SELECT COUNT(*) AS total FROM "${table}"`).get() as { total: number }).total);
}
