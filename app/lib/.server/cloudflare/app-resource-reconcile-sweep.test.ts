import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveCredential = vi.hoisted(() => vi.fn());
const reconcileAppResources = vi.hoisted(() => vi.fn());

vi.mock('./cloudflare-credential-vault', () => ({
  D1CloudflareCredentialVault: { fromEnv: () => ({ resolve: resolveCredential }) },
}));
vi.mock('./user-account-api', () => ({
  UserCloudflareAccountApi: class {
    constructor(
      readonly accountId: string,
      readonly accessToken: string,
    ) {}
  },
}));
vi.mock('~/lib/cloudflare/data/app-resource-reconcile.server', () => ({
  APP_RESOURCE_RECONCILE_MODE: 'report',
  reconcileAppResources,
}));

import { runAppResourceReconciliation } from './app-resource-reconcile-sweep';

const NOW = 1_800_000_000_000;
const DEPLOYMENT = 'd6738251-57e1-4d83-9589-1b6c6d982417';

type ConnectedAccount = { user_id: string; account_id: string; credential_handle: string };

type Statement = { sql: string; values: unknown[] };

class FakeDb {
  statements: Statement[] = [];
  failSelect = false;

  constructor(private readonly accounts: ConnectedAccount[]) {}

  prepare(sql: string) {
    const normalized = sql.replaceAll(/\s+/g, ' ').trim();
    let values: unknown[] = [];
    const statement = {
      bind: (...bound: unknown[]) => {
        values = bound;
        return statement;
      },
      all: async () => {
        if (this.failSelect) {
          throw new Error('D1_ERROR: connected account listing is unavailable.');
        }
        this.statements.push({ sql: normalized, values });
        return { results: this.accounts };
      },
      run: async () => {
        this.statements.push({ sql: normalized, values });
        return { success: true, meta: { changes: 1 } };
      },
    };
    return statement as unknown as D1PreparedStatement;
  }

  receipt(prefix: string): Statement | undefined {
    return this.statements.find((statement) => statement.sql.startsWith(prefix));
  }
}

function env(db: FakeDb): Env {
  return { DB: db } as unknown as Env;
}

function account(id: string): ConnectedAccount {
  return { user_id: id, account_id: `account-${id}`, credential_handle: `handle-${id}` };
}

function report(overrides: Partial<Record<string, unknown>> = {}) {
  return { scanned: 0, orphans: [], deleted: [], skippedListings: [], ...overrides };
}

describe('app resource reconciliation sweep', () => {
  beforeEach(() => {
    resolveCredential.mockReset().mockResolvedValue('access-token');
    reconcileAppResources.mockReset().mockResolvedValue(report());
  });

  it('sweeps every connected account with the credentials that never leave the control plane', async () => {
    const db = new FakeDb([account('user-1'), account('user-2')]);

    const summary = await runAppResourceReconciliation(env(db), NOW);

    expect(resolveCredential.mock.calls.flat()).toEqual(['handle-user-1', 'handle-user-2']);
    expect(reconcileAppResources.mock.calls.map(([api]) => api.accountId)).toEqual([
      'account-user-1',
      'account-user-2',
    ]);
    expect(reconcileAppResources.mock.calls.every(([, options]) => options.mode === 'report')).toBe(true);
    expect(summary).toMatchObject({ users: 2, failures: 0, orphans: 0, deleted: 0 });
    expect(summary.skippedListings.size).toBe(0);
  });

  it('records the run so local tooling can read the diff without a dashboard', async () => {
    const db = new FakeDb([account('user-1')]);
    reconcileAppResources.mockResolvedValue(
      report({
        scanned: 4,
        orphans: [
          { kind: 'd1', id: 'db', name: `ghostbuild-${DEPLOYMENT}` },
          { kind: 'r2', id: 'bucket', name: `ghostbuild-${DEPLOYMENT}-storage` },
        ],
        skippedListings: ['KV namespace'],
      }),
    );

    const summary = await runAppResourceReconciliation(env(db), NOW);

    expect(db.receipt('INSERT INTO app_resource_reconcile_runs')?.values).toEqual([summary.runId, 'report', NOW]);
    const finished = db.receipt('UPDATE app_resource_reconcile_runs')!;
    const [
      status,
      ,
      usersScanned,
      usersFailed,
      resourcesScanned,
      orphansFound,
      orphansJson,
      deleted,
      listingSkipped,
      skippedListingsJson,
    ] = finished.values;
    expect(status).toBe('ok');
    expect([usersScanned, usersFailed, resourcesScanned, orphansFound, deleted, listingSkipped]).toEqual([
      1, 0, 4, 2, 0, 1,
    ]);
    // A skip is only actionable when it names the listing that could not be read.
    expect(JSON.parse(String(skippedListingsJson))).toEqual(['KV namespace']);
    expect(JSON.parse(String(orphansJson))).toEqual([
      { userId: 'user-1', kind: 'd1', name: `ghostbuild-${DEPLOYMENT}` },
      { userId: 'user-1', kind: 'r2', name: `ghostbuild-${DEPLOYMENT}-storage` },
    ]);
  });

  it('counts an unreadable account without abandoning the rest of the sweep', async () => {
    const db = new FakeDb([account('user-1'), account('user-2')]);
    resolveCredential.mockRejectedValueOnce(new Error('The stored Cloudflare credential could not be decrypted.'));

    const summary = await runAppResourceReconciliation(env(db), NOW);

    expect(reconcileAppResources).toHaveBeenCalledOnce();
    expect(summary).toMatchObject({ users: 2, failures: 1 });
    expect(db.receipt('UPDATE app_resource_reconcile_runs')?.values[3]).toBe(1);
  });

  it('reports rather than deletes, so the receipt can be trusted before enforcement is', async () => {
    const db = new FakeDb([account('user-1')]);
    reconcileAppResources.mockResolvedValue(
      report({ scanned: 1, orphans: [{ kind: 'kv', id: 'kv', name: `ghostbuild-${DEPLOYMENT}-cache` }] }),
    );

    const summary = await runAppResourceReconciliation(env(db), NOW);

    expect(summary.orphans).toBe(1);
    expect(summary.deleted).toBe(0);
    expect(db.receipt('UPDATE app_resource_reconcile_runs')?.values[0]).toBe('ok');
  });

  it('leaves a failed run recorded as failed rather than silently absent', async () => {
    const db = new FakeDb([]);
    db.failSelect = true;

    await expect(runAppResourceReconciliation(env(db), NOW)).rejects.toThrow('connected account listing');

    const finished = db.receipt('UPDATE app_resource_reconcile_runs')!;
    expect(finished.values[0]).toBe('error');
    expect(finished.values.at(-2)).toContain('connected account listing is unavailable.');
  });
});
