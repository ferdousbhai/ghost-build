import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CloudflareConnectionResult,
  CloudflareOrchestrator,
} from '~/lib/.server/cloudflare/cloudflare-orchestrator';

const getSession = vi.fn();

vi.mock('~/lib/.server/auth', () => ({
  getAuth: () => ({ api: { getSession } }),
}));

import {
  cloudflareConnectionStatusAction,
  completeCloudflareConnectionAction,
  startCloudflareConnectionAction,
} from './cloudflare-integration';

function envWithConnection(row: Record<string, unknown> | null) {
  return {
    DB: {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({ first: vi.fn(async () => row) })),
      })),
    },
  } as unknown as Env;
}

describe('cloudflareConnectionStatusAction', () => {
  beforeEach(() => getSession.mockReset());

  it('requires a Ghostbuild identity', async () => {
    getSession.mockResolvedValue(null);
    const response = await cloudflareConnectionStatusAction({
      request: new Request('https://ghostbuild.dev/api/cloudflare/connection'),
      env: envWithConnection(null),
    });
    expect(response.status).toBe(401);
  });

  it('reports an unconnected authenticated user', async () => {
    getSession.mockResolvedValue({ user: { id: 'user-1' } });
    const response = await cloudflareConnectionStatusAction({
      request: new Request('https://ghostbuild.dev/api/cloudflare/connection'),
      env: envWithConnection(null),
    });
    expect(await response.json()).toEqual({ connected: false, status: null, aiBillingEnabled: false });
  });

  it('never returns credential or account identifiers', async () => {
    getSession.mockResolvedValue({ user: { id: 'user-1' } });
    const response = await cloudflareConnectionStatusAction({
      request: new Request('https://ghostbuild.dev/api/cloudflare/connection'),
      env: envWithConnection({
        id: 'connection-1',
        user_id: 'user-1',
        account_id: 'secret-account-id',
        account_name: 'My Cloudflare',
        status: 'active',
        credential_handle: 'secret-handle',
        granted_scopes_json: '["workers_ai"]',
        ai_billing_enabled: 1,
        connected_at: 123,
        updated_at: 456,
      }),
    });
    expect(await response.json()).toEqual({
      connected: true,
      status: 'active',
      accountName: 'My Cloudflare',
      aiBillingEnabled: true,
      connectedAt: 123,
    });
  });

  it('fails closed when the partner sandbox is not configured', async () => {
    getSession.mockResolvedValue({ user: { id: 'user-1', email: 'person@example.com' } });
    const response = await startCloudflareConnectionAction({
      request: new Request('https://ghostbuild.dev/api/cloudflare/connection/start', { method: 'POST' }),
      env: envWithConnection(null),
    });
    expect(response.status).toBe(503);
  });

  it('creates a server-owned, expiring connection state', async () => {
    getSession.mockResolvedValue({ user: { id: 'user-1', email: 'person@example.com' } });
    const database = integrationDatabase();
    const orchestrator = fakeOrchestrator();
    const response = await startCloudflareConnectionAction({
      request: new Request('https://ghostbuild.dev/api/cloudflare/connection/start', { method: 'POST' }),
      env: database.env,
      orchestrator,
    });
    expect(response.status).toBe(201);
    const session = database.sessions.values().next().value;
    expect(session).toMatchObject({ userId: 'user-1', providerSessionId: 'provider-session', status: 'pending' });
    expect(orchestrator.startConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        userEmail: 'person@example.com',
        requestedCapabilities: ['workers', 'd1', 'r2', 'durable_objects', 'workers_ai'],
      }),
    );
    const returnUrl = new URL(vi.mocked(orchestrator.startConnection).mock.calls[0][0].returnUrl);
    expect(returnUrl.searchParams.get('state')).toBe(session?.id);
  });

  it('encrypts the provider credential and prevents callback replay', async () => {
    getSession.mockResolvedValue(null);
    const database = integrationDatabase();
    const state = '00000000-0000-4000-8000-000000000001';
    database.sessions.set(state, {
      id: state,
      userId: 'user-1',
      providerSessionId: 'provider-session',
      status: 'pending',
      expiresAt: Date.now() + 60_000,
    });
    const callbackRequest = () =>
      new Request('https://ghostbuild.dev/api/cloudflare/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ state, code: 'authorization-code' }),
      });
    const response = await completeCloudflareConnectionAction({
      request: callbackRequest(),
      env: database.env,
      orchestrator: fakeOrchestrator(),
    });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://ghostbuild.dev/settings?cloudflare=connected');
    expect(getSession).not.toHaveBeenCalled();
    expect(database.connection).toMatchObject({ status: 'active', account_id: 'account-1', ai_billing_enabled: 1 });
    expect(JSON.stringify([...database.credentials.values()])).not.toContain('provider-access-token');
    expect(database.sessions.get(state)?.status).toBe('completed');

    const replay = await completeCloudflareConnectionAction({
      request: callbackRequest(),
      env: database.env,
      orchestrator: fakeOrchestrator(),
    });
    expect(replay.status).toBe(404);
  });
});

function fakeOrchestrator(): CloudflareOrchestrator {
  return {
    startConnection: vi.fn(async () => ({
      sessionId: 'provider-session',
      authorizationUrl: 'https://dash.cloudflare.com/authorize',
      expiresAt: Date.now() + 60_000,
    })),
    completeConnection: vi.fn(async () => ({
      accountId: 'account-1',
      accountName: 'User Cloudflare',
      accessToken: 'provider-access-token',
      grantedCapabilities: [
        'workers',
        'd1',
        'r2',
        'durable_objects',
        'workers_ai',
      ] as CloudflareConnectionResult['grantedCapabilities'],
    })),
  };
}

function integrationDatabase() {
  type Session = {
    id: string;
    userId: string;
    providerSessionId: string;
    status: string;
    expiresAt: number;
  };
  const sessions = new Map<string, Session>();
  const credentials = new Map<string, { ciphertext_base64: string; iv_base64: string }>();
  const state: { connection: Record<string, unknown> | null } = { connection: null };
  const prepare = vi.fn((sql: string) => ({
    bind: (...values: unknown[]) => ({
      first: async () => {
        if (sql.includes('FROM cloudflare_connections')) {
          return state.connection;
        }
        if (sql.includes('FROM cloudflare_connection_sessions')) {
          const session = sessions.get(values[0] as string);
          return session && session.status === 'pending'
            ? {
                user_id: session.userId,
                provider_session_id: session.providerSessionId,
                expires_at: session.expiresAt,
              }
            : null;
        }
        return null;
      },
      run: async () => {
        if (sql.includes('INSERT INTO cloudflare_connection_sessions')) {
          sessions.set(values[0] as string, {
            id: values[0] as string,
            userId: values[1] as string,
            providerSessionId: values[2] as string,
            status: 'pending',
            expiresAt: values[3] as number,
          });
        } else if (sql.includes('INSERT INTO cloudflare_credentials')) {
          credentials.set(values[0] as string, {
            ciphertext_base64: values[1] as string,
            iv_base64: values[2] as string,
          });
        } else if (sql.includes('INSERT INTO cloudflare_connections')) {
          state.connection = {
            id: values[0],
            user_id: values[1],
            account_id: values[2],
            account_name: values[3],
            status: 'active',
            credential_handle: values[4],
            granted_scopes_json: values[5],
            ai_billing_enabled: values[6],
            connected_at: values[7],
            updated_at: values[9],
          };
        } else if (sql.includes("SET status = 'completed'")) {
          const session = sessions.get(values[1] as string);
          if (session) {
            session.status = 'completed';
          }
        } else if (sql.includes("SET status = 'expired'")) {
          const session = sessions.get(values[1] as string);
          if (session) {
            session.status = 'expired';
          }
        } else if (sql.startsWith('DELETE FROM cloudflare_credentials')) {
          credentials.delete(values[0] as string);
        }
        return { success: true, meta: { changes: 1 } };
      },
    }),
  }));
  const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
  return {
    env: { DB: { prepare }, CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY: key } as unknown as Env,
    sessions,
    credentials,
    get connection() {
      return state.connection;
    },
  };
}
