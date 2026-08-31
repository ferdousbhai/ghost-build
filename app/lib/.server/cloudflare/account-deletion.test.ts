import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { DatabaseSync as DatabaseSyncInstance, SQLInputValue } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { eraseControlPlaneAccount } from './account-deletion';
import { D1CloudflareCredentialVault } from './cloudflare-credential-vault';

const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const CONTROL_PLANE_TABLES = [
  'user',
  'cloudflare_credentials',
  'cloudflare_connections',
  'cloudflare_auth_sessions',
  'cloudflare_oauth_states',
  'user_computer_runtimes',
];

describe('control-plane account erasure', () => {
  it('erases every operator-held record and revokes the Cloudflare grant', async () => {
    const { database, db } = controlPlaneDatabase();
    const revoke = vi.fn(async () => new Response(null, { status: 200 }));
    const vault = new D1CloudflareCredentialVault(db, ENCRYPTION_KEY, {
      clientId: 'client',
      clientSecret: 'secret',
      request: revoke as unknown as typeof fetch,
    });
    const handle = await vault.storeOAuthCredential({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 3_600_000,
    });
    seedAccount(database, handle);

    await expect(eraseControlPlaneAccount({ env: { DB: db } as Env, userId: 'user-1', vault })).resolves.toEqual({
      oauthStates: 1,
      runtimeLocators: 1,
      authSessions: 1,
      connections: 1,
      credentials: 1,
      accounts: 1,
      cloudflareAuthorizationRevoked: true,
    });
    expect(revoke).toHaveBeenCalledWith('https://dash.cloudflare.com/oauth2/revoke', expect.anything());
    for (const table of CONTROL_PLANE_TABLES) {
      expect({ table, rows: rowCount(database, table) }).toEqual({ table, rows: 0 });
    }
  });

  it('repeats without error and reports that nothing remained', async () => {
    const { database, db } = controlPlaneDatabase();
    const vault = credentialVault(db);
    const handle = await vault.storeOAuthCredential({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 3_600_000,
    });
    seedAccount(database, handle);
    const erase = () => eraseControlPlaneAccount({ env: { DB: db } as Env, userId: 'user-1', vault });

    await erase();

    await expect(erase()).resolves.toEqual({
      oauthStates: 0,
      runtimeLocators: 0,
      authSessions: 0,
      connections: 0,
      credentials: 0,
      accounts: 0,
      cloudflareAuthorizationRevoked: false,
    });
  });

  it('still erases the stored ciphertext when Cloudflare refuses the revocation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { database, db } = controlPlaneDatabase();
    const vault = new D1CloudflareCredentialVault(db, ENCRYPTION_KEY, {
      clientId: 'client',
      clientSecret: 'secret',
      request: (async () => {
        throw new Error('refresh=secret-token');
      }) as unknown as typeof fetch,
    });
    const handle = await vault.storeOAuthCredential({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 3_600_000,
    });
    seedAccount(database, handle);

    const erasure = await eraseControlPlaneAccount({ env: { DB: db } as Env, userId: 'user-1', vault });

    expect(erasure.cloudflareAuthorizationRevoked).toBe(false);
    expect(erasure.credentials).toBe(1);
    expect(rowCount(database, 'cloudflare_credentials')).toBe(0);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-token');
    warn.mockRestore();
  });

  it('says the ciphertext survived rather than reporting that there was none to erase', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { database, db } = controlPlaneDatabase();
    const vault = credentialVault(db);
    const handle = await vault.storeOAuthCredential({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 3_600_000,
    });
    seedAccount(database, handle);
    vi.spyOn(vault, 'deleteIfUnreferenced').mockRejectedValue(new Error('D1_ERROR: database is locked'));

    const erasure = await eraseControlPlaneAccount({ env: { DB: db } as Env, userId: 'user-1', vault });

    // Zero is the honest count, but only the log distinguishes it from "there was nothing here".
    expect(erasure.credentials).toBe(0);
    expect(rowCount(database, 'cloudflare_credentials')).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('the ciphertext remains'),
      expect.stringContaining('database is locked'),
    );
    warn.mockRestore();
  });

  it('leaves an unrelated account untouched', async () => {
    const { database, db } = controlPlaneDatabase();
    seedAccount(database, null, 'user-2');

    await eraseControlPlaneAccount({ env: { DB: db } as Env, userId: 'user-1', vault: credentialVault(db) });

    expect(rowCount(database, 'user')).toBe(1);
    expect(rowCount(database, 'cloudflare_connections')).toBe(1);
  });
});

function credentialVault(db: D1Database): D1CloudflareCredentialVault {
  return new D1CloudflareCredentialVault(db, ENCRYPTION_KEY, {
    clientId: 'client',
    clientSecret: 'secret',
    request: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
  });
}

function seedAccount(database: DatabaseSyncInstance, credentialHandle: string | null, userId = 'user-1'): void {
  database
    .prepare(
      `INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt, cloudflare_subject)
       VALUES (?, 'Test', ?, 1, NULL, 1, 1, ?)`,
    )
    .run(userId, `${userId}@example.test`, userId);
  database
    .prepare(
      `INSERT INTO cloudflare_connections
        (id, user_id, account_id, account_name, status, credential_handle, granted_capabilities_json,
         ai_billing_enabled, connected_at, created_at, updated_at)
       VALUES (?, ?, 'account-1', 'Account', 'active', ?, '["workers"]', 1, 1, 1, 1)`,
    )
    .run(`connection-${userId}`, userId, credentialHandle);
  database
    .prepare(
      `INSERT INTO cloudflare_auth_sessions (id, user_id, token_hash, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, 9999999999999, 1, 1)`,
    )
    .run(`session-${userId}`, userId, `hash-${userId}`);
  database
    .prepare(
      `INSERT INTO cloudflare_oauth_states
        (id, provider_session_id, return_to, status, expires_at, authenticated_user_id, created_at, updated_at)
       VALUES (?, ?, '/', 'completed', 9999999999999, ?, 1, 1)`,
    )
    .run(`state-${userId}`, `provider-${userId}`, userId);
  database
    .prepare(
      `INSERT INTO user_computer_runtimes
        (user_id, connection_id, connection_generation, worker_name, endpoint, runtime_version, status,
         last_error, created_at, updated_at)
       VALUES (?, ?, 1, 'worker', 'https://runtime.example', 'sha', 'ready', NULL, 1, 1)`,
    )
    .run(userId, `connection-${userId}`);
}

function controlPlaneDatabase(): { database: DatabaseSyncInstance; db: D1Database } {
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (location: string) => DatabaseSyncInstance;
  };
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON;');
  // Apply the shipped migrations so erasure is proven against the real schema.
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
      });
      return { ...statement([]), bind: (...values: unknown[]) => statement(values) };
    },
    batch: async (statements: D1PreparedStatement[]) => Promise.all(statements.map((statement) => statement.run())),
  } as unknown as D1Database;
  return { database, db };
}

function rowCount(database: DatabaseSyncInstance, table: string): number {
  return Number((database.prepare(`SELECT COUNT(*) AS total FROM "${table}"`).get() as { total: number }).total);
}
