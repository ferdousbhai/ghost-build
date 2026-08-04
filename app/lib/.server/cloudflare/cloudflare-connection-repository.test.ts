import { describe, expect, it } from 'vitest';
import {
  activateCloudflareConnection,
  CloudflareConnectionChangedError,
  findCloudflareConnectionForUser,
} from './cloudflare-connection-repository';

describe('activateCloudflareConnection', () => {
  it('rejects a stale OAuth completion instead of overwriting the winning credential handle', async () => {
    const database = connectionDatabase({ generation: 5, credentialHandle: 'credential-winner' });

    await expect(
      activateCloudflareConnection({
        db: database.db,
        userId: 'user-1',
        accountId: 'account-1',
        accountName: 'Account',
        credentialHandle: 'credential-loser',
        grantedScopes: ['workers'],
        aiBillingEnabled: false,
        expectedGeneration: 4,
        now: 100,
      }),
    ).rejects.toBeInstanceOf(CloudflareConnectionChangedError);

    expect(database.credentialHandle).toBe('credential-winner');
    expect(database.generation).toBe(5);
  });

  it('advances the generation when the observed connection is still current', async () => {
    const database = connectionDatabase({ generation: 5, credentialHandle: 'credential-old' });

    const connection = await activateCloudflareConnection({
      db: database.db,
      userId: 'user-1',
      accountId: 'account-2',
      accountName: 'New account',
      credentialHandle: 'credential-new',
      grantedScopes: ['workers', 'workers_ai'],
      aiBillingEnabled: true,
      expectedGeneration: 5,
      now: 200,
    });

    expect(connection.credentialHandle).toBe('credential-new');
    expect(connection.generation).toBe(6);
  });

  it('returns the committed CAS row without a fallible follow-up read', async () => {
    const database = connectionDatabase({ generation: 2, credentialHandle: 'credential-old' }, { failSelect: true });

    await expect(
      activateCloudflareConnection({
        db: database.db,
        userId: 'user-1',
        accountId: 'account-2',
        accountName: 'New account',
        credentialHandle: 'credential-committed',
        grantedScopes: ['workers'],
        aiBillingEnabled: false,
        expectedGeneration: 2,
        now: 300,
      }),
    ).resolves.toMatchObject({ credentialHandle: 'credential-committed', generation: 3 });

    expect(database.selects).toBe(0);
    expect(database.credentialHandle).toBe('credential-committed');
  });

  it('adopts the exact committed update when its D1 acknowledgement is lost', async () => {
    const acknowledgementError = new Error('D1 acknowledgement lost');
    const database = connectionDatabase(
      { generation: 2, credentialHandle: 'credential-old' },
      { updateErrorAfterCommit: acknowledgementError },
    );

    await expect(
      activateCloudflareConnection({
        db: database.db,
        userId: 'user-1',
        accountId: 'account-2',
        accountName: 'New account',
        credentialHandle: 'credential-committed',
        grantedScopes: ['workers', 'workers_ai'],
        aiBillingEnabled: true,
        expectedGeneration: 2,
        now: 300,
      }),
    ).resolves.toMatchObject({ credentialHandle: 'credential-committed', generation: 3, updatedAt: 300 });

    expect(database.selects).toBe(1);
  });

  it('preserves the D1 error when reconciliation observes a competing connection', async () => {
    const acknowledgementError = new Error('D1 unavailable');
    const database = connectionDatabase(
      { generation: 6, credentialHandle: 'credential-winner' },
      { updateErrorWithoutCommit: acknowledgementError },
    );

    await expect(
      activateCloudflareConnection({
        db: database.db,
        userId: 'user-1',
        accountId: 'account-2',
        accountName: 'New account',
        credentialHandle: 'credential-loser',
        grantedScopes: ['workers'],
        aiBillingEnabled: false,
        expectedGeneration: 5,
        now: 300,
      }),
    ).rejects.toBe(acknowledgementError);

    expect(database.credentialHandle).toBe('credential-winner');
    expect(database.generation).toBe(6);
  });

  it('returns a newly inserted connection from the same atomic statement', async () => {
    const db = newConnectionDatabase();

    await expect(
      activateCloudflareConnection({
        db,
        userId: 'user-new',
        accountId: 'account-new',
        accountName: null,
        credentialHandle: 'credential-new',
        grantedScopes: ['workers'],
        aiBillingEnabled: false,
        expectedGeneration: null,
        now: 400,
      }),
    ).resolves.toMatchObject({
      userId: 'user-new',
      credentialHandle: 'credential-new',
      generation: 1,
    });
  });

  it('adopts the exact committed insert when its D1 acknowledgement is lost', async () => {
    const acknowledgementError = new Error('D1 acknowledgement lost');
    const db = newConnectionDatabase({ insertErrorAfterCommit: acknowledgementError });

    await expect(
      activateCloudflareConnection({
        db,
        userId: 'user-new',
        accountId: 'account-new',
        accountName: null,
        credentialHandle: 'credential-new',
        grantedScopes: ['workers'],
        aiBillingEnabled: false,
        expectedGeneration: null,
        now: 400,
      }),
    ).resolves.toMatchObject({
      userId: 'user-new',
      credentialHandle: 'credential-new',
      generation: 1,
    });
  });

  it('rejects corrupt persisted capability scopes instead of silently removing them', async () => {
    const row = {
      id: 'connection-1',
      user_id: 'user-1',
      account_id: 'account-1',
      account_name: 'Account',
      status: 'active',
      credential_handle: 'credential-1',
      granted_scopes_json: '{invalid',
      ai_billing_enabled: 0,
      connected_at: 1,
      updated_at: 1,
      connection_generation: 1,
    };
    const db = {
      prepare: () => ({ bind: () => ({ first: async () => row }) }),
    } as unknown as D1Database;

    await expect(findCloudflareConnectionForUser(db, 'user-1')).rejects.toThrow(
      'Stored Cloudflare connection scopes are invalid',
    );
  });
});

function connectionDatabase(
  initial: { generation: number; credentialHandle: string },
  options: {
    failSelect?: boolean;
    updateErrorAfterCommit?: Error;
    updateErrorWithoutCommit?: Error;
  } = {},
) {
  const state = {
    generation: initial.generation,
    credentialHandle: initial.credentialHandle,
    accountId: 'account-1',
    accountName: 'Account' as string | null,
    scopes: ['workers'],
    aiBillingEnabled: 0,
    connectedAt: 1,
    updatedAt: 1,
  };
  let selects = 0;
  const row = () => ({
    id: 'connection-1',
    user_id: 'user-1',
    account_id: state.accountId,
    account_name: state.accountName,
    status: 'active' as const,
    credential_handle: state.credentialHandle,
    granted_scopes_json: JSON.stringify(state.scopes),
    ai_billing_enabled: state.aiBillingEnabled,
    connected_at: state.connectedAt,
    updated_at: state.updatedAt,
    connection_generation: state.generation,
  });
  const applyUpdate = (values: unknown[]) => {
    const expectedGeneration = values[8] as number;
    if (expectedGeneration !== state.generation) {
      return false;
    }
    state.accountId = values[0] as string;
    state.accountName = values[1] as string | null;
    state.credentialHandle = values[2] as string;
    state.scopes = JSON.parse(values[3] as string) as string[];
    state.aiBillingEnabled = values[4] as number;
    state.connectedAt = values[5] as number;
    state.updatedAt = values[6] as number;
    state.generation++;
    return true;
  };
  const db = {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          return {
            run: async () => {
              if (!query.includes('UPDATE cloudflare_connections')) {
                return changed(0);
              }
              return changed(applyUpdate(values) ? 1 : 0);
            },
            first: async () => {
              if (query.includes('UPDATE cloudflare_connections')) {
                if (options.updateErrorWithoutCommit) {
                  throw options.updateErrorWithoutCommit;
                }
                const committed = applyUpdate(values);
                if (committed && options.updateErrorAfterCommit) {
                  throw options.updateErrorAfterCommit;
                }
                return committed ? row() : null;
              }
              if (query.includes('SELECT')) {
                selects++;
                if (options.failSelect) {
                  throw new Error('follow-up read failed');
                }
                return row();
              }
              return null;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return {
    db,
    get generation() {
      return state.generation;
    },
    get credentialHandle() {
      return state.credentialHandle;
    },
    get selects() {
      return selects;
    },
  };
}

function newConnectionDatabase(options: { insertErrorAfterCommit?: Error } = {}): D1Database {
  let committed: ReturnType<typeof insertedConnectionRow> | null = null;
  return {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          return {
            first: async () => {
              if (query.includes('INSERT INTO cloudflare_connections')) {
                expect(query).toContain('RETURNING');
                committed = insertedConnectionRow(values);
                if (options.insertErrorAfterCommit) {
                  throw options.insertErrorAfterCommit;
                }
                return committed;
              }
              expect(query).toContain('FROM cloudflare_connections');
              return committed;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

function insertedConnectionRow(values: unknown[]) {
  return {
    id: values[0] as string,
    user_id: values[1] as string,
    account_id: values[2] as string,
    account_name: values[3] as string | null,
    status: 'active' as const,
    credential_handle: values[4] as string,
    granted_scopes_json: values[5] as string,
    ai_billing_enabled: values[6] as number,
    connected_at: values[7] as number,
    updated_at: values[9] as number,
    connection_generation: 1,
  };
}

function changed(changes: number) {
  return { success: true, meta: { changes } } as D1Result;
}
