import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CloudflareConnectionResult,
  CloudflareOrchestrator,
} from '~/lib/.server/cloudflare/cloudflare-orchestrator';
import {
  APP_AGENT_SECURITY_BOUNDARY_SHA256,
  DEPLOYMENT_SECURITY_BASELINE_VERSION,
  TEMPLATE_SOURCE_SHA256,
} from '~/lib/.server/cloudflare/deployment-security-baseline';

const mocks = vi.hoisted(() => ({
  CloudflareConnectionChangedError: class CloudflareConnectionChangedError extends Error {},
  getAuthSession: vi.fn(),
  prepareAuthSession: vi.fn(),
  createAuthSession: vi.fn(),
  upsertCloudflareUser: vi.fn(),
  findConnection: vi.fn(),
  activateConnection: vi.fn(),
  vault: {
    storeOAuthCredential: vi.fn(),
    store: vi.fn(),
    deleteIfUnreferenced: vi.fn(),
  },
}));

vi.mock('~/lib/.server/auth', () => ({
  getAuthSession: mocks.getAuthSession,
  prepareAuthSession: mocks.prepareAuthSession,
  createAuthSession: mocks.createAuthSession,
  upsertCloudflareUser: mocks.upsertCloudflareUser,
}));
vi.mock('~/lib/.server/cloudflare/cloudflare-connection-repository', () => ({
  findCloudflareConnectionForUser: mocks.findConnection,
  activateCloudflareConnection: mocks.activateConnection,
  CloudflareConnectionChangedError: mocks.CloudflareConnectionChangedError,
}));
vi.mock('~/lib/.server/cloudflare/cloudflare-credential-vault', () => ({
  D1CloudflareCredentialVault: class {
    static fromEnv() {
      return mocks.vault;
    }
  },
}));

import {
  CLOUDFLARE_CONNECTION_CALLBACK_METHOD,
  cloudflareConnectionStatusAction,
  completeCloudflareConnectionAction,
  startCloudflareConnectionAction,
} from './cloudflare-integration';

describe('Cloudflare-only authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prepareAuthSession.mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      tokenHash: 'f'.repeat(64),
      expiresAt: 2_592_000_100,
      createdAt: 100,
      cookie: 'ghostbuild_session=opaque; HttpOnly; Secure',
    });
    mocks.createAuthSession.mockImplementation(async (_env, session) => session.cookie);
    mocks.upsertCloudflareUser.mockResolvedValue({
      id: 'user-1',
      name: 'Person',
      email: 'person@example.com',
      image: null,
    });
    mocks.findConnection.mockResolvedValue(null);
    mocks.vault.storeOAuthCredential.mockResolvedValue('credential-1');
    mocks.vault.deleteIfUnreferenced.mockResolvedValue(true);
    mocks.activateConnection.mockResolvedValue({
      id: 'connection-1',
      userId: 'user-1',
      accountId: 'account-1',
      accountName: 'User Cloudflare',
      status: 'active',
      credentialHandle: 'credential-1',
      grantedScopes: ['workers', 'd1', 'r2', 'durable_objects', 'workers_ai'],
      aiBillingEnabled: true,
      connectedAt: 100,
      updatedAt: 100,
      generation: 1,
    });
  });

  it('uses the top-level GET callback supported by Cloudflare OAuth', () => {
    expect(CLOUDFLARE_CONNECTION_CALLBACK_METHOD).toBe('GET');
  });

  it('requires Cloudflare authentication for connection status', async () => {
    mocks.getAuthSession.mockResolvedValue(null);
    const response = await cloudflareConnectionStatusAction({
      request: new Request('https://ghostbuild.dev/api/cloudflare/connection'),
      env: { DB: {} } as Env,
    });
    expect(response.status).toBe(401);
  });

  it('returns a bounded owner-scoped deployment security status without provider internals', async () => {
    mocks.getAuthSession.mockResolvedValue({ user: { id: 'user-1' } });
    mocks.findConnection.mockResolvedValue({
      id: 'connection-1',
      userId: 'user-1',
      accountId: 'account-1',
      accountName: 'User Cloudflare',
      status: 'active',
      credentialHandle: 'credential-secret',
      grantedScopes: ['workers'],
      aiBillingEnabled: false,
      connectedAt: 100,
      updatedAt: 100,
      generation: 1,
    });
    const rows = [
      deploymentSecurityRow({
        status: 'current',
        expected_template_source_sha256: TEMPLATE_SOURCE_SHA256,
        expected_security_baseline_version: DEPLOYMENT_SECURITY_BASELINE_VERSION,
        expected_security_boundary_sha256: APP_AGENT_SECURITY_BOUNDARY_SHA256,
      }),
      deploymentSecurityRow({
        status: 'current',
        deployment_id: 'deployment-old',
        chat_id: 'chat with spaces',
        expected_template_source_sha256: 'a'.repeat(64),
      }),
      deploymentSecurityRow({
        status: 'current',
        deployment_id: null,
        chat_id: null,
        is_managed: 0,
        expected_template_source_sha256: TEMPLATE_SOURCE_SHA256,
        expected_security_baseline_version: DEPLOYMENT_SECURITY_BASELINE_VERSION,
        expected_security_boundary_sha256: APP_AGENT_SECURITY_BOUNDARY_SHA256,
      }),
      deploymentSecurityRow({ status: 'unreachable', production_url: 'javascript:alert(1)' }),
      deploymentSecurityRow({ status: 'not_found', deployment_id: null, is_managed: 0 }),
    ];
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind(...values: unknown[]) {
              queries.push({ sql, values });
              return { all: async () => ({ results: rows }) };
            },
          };
        },
      },
    } as unknown as Env;

    const response = await cloudflareConnectionStatusAction({
      request: new Request('https://ghostbuild.dev/api/cloudflare/connection'),
      env,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    const body = await response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      connected: true,
      deploymentSecurity: {
        state: 'action_required',
        hasMore: false,
        nextCursor: null,
        items: [
          { scope: 'managed', state: 'current', workerName: 'ghostbuild-deployment-1', remediation: null },
          {
            scope: 'managed',
            state: 'upgrade_available',
            remediation: {
              kind: 'replace_from_fresh_builder',
              builderPath: '/',
              manualCleanupRequired: true,
            },
          },
          {
            scope: 'historical',
            state: 'user_action_required',
            remediation: {
              kind: 'replace_from_fresh_builder',
              builderPath: '/',
              manualCleanupRequired: true,
            },
          },
          {
            state: 'verification_failed',
            productionUrl: null,
            remediation: { kind: 'reauthorize_cloudflare' },
          },
          { state: 'not_applicable', remediation: null },
        ],
      },
    });
    expect(JSON.stringify(body)).not.toContain('credential-secret');
    expect(JSON.stringify(body)).not.toContain('account-1');
    expect(JSON.stringify(body)).not.toContain('etag');
    expect(queries).toHaveLength(2);
    expect(queries[1]?.values).toEqual(['user-1', 'connection-1', null, null, 26, 'user-1', 'connection-1']);
    expect(queries[1]!.sql.indexOf('WHERE user_id = ? AND connection_id = ?')).toBeLessThan(
      queries[1]!.sql.indexOf('LEFT JOIN deployments'),
    );
  });

  it('keeps a full current page partial until a drifted continuation row becomes visible', async () => {
    mocks.getAuthSession.mockResolvedValue({ user: { id: 'user-1' } });
    mocks.findConnection.mockResolvedValue({
      id: 'connection-1',
      status: 'active',
      accountName: null,
      aiBillingEnabled: false,
      connectedAt: 100,
    });
    let preparedSql = '';
    const currentRow = deploymentSecurityRow({
      status: 'current',
      expected_template_source_sha256: TEMPLATE_SOURCE_SHA256,
      expected_security_baseline_version: DEPLOYMENT_SECURITY_BASELINE_VERSION,
      expected_security_boundary_sha256: APP_AGENT_SECURITY_BOUNDARY_SHA256,
    });
    const currentRows = Array.from({ length: 25 }, (_, index) =>
      deploymentSecurityRow({ ...currentRow, worker_name: `ghostbuild-${String(index + 1).padStart(3, '0')}` }),
    );
    const driftedRow = deploymentSecurityRow({ status: 'drifted', worker_name: 'ghostbuild-026' });
    const env = {
      DB: {
        prepare(sql: string) {
          preparedSql = sql;
          return {
            bind(...values: unknown[]) {
              const cursor = values[2];
              return {
                all: async () => ({
                  results:
                    cursor === null ? [...currentRows, driftedRow] : cursor === 'ghostbuild-025' ? [driftedRow] : [],
                }),
              };
            },
          };
        },
      },
    } as unknown as Env;

    const firstResponse = await cloudflareConnectionStatusAction({
      request: new Request('https://ghostbuild.dev/api/cloudflare/connection'),
      env,
    });

    const firstBody = await firstResponse.json<{
      deploymentSecurity: {
        state: string;
        hasMore: boolean;
        nextCursor: string | null;
        items: Array<{ state: string; workerName: string | null }>;
      };
    }>();
    expect(firstBody.deploymentSecurity).toMatchObject({
      state: 'checking',
      hasMore: true,
      nextCursor: 'ghostbuild-025',
    });
    expect(firstBody.deploymentSecurity.items).toHaveLength(25);
    expect(firstBody.deploymentSecurity.items.every((item) => item.state === 'current')).toBe(true);

    const continuationResponse = await cloudflareConnectionStatusAction({
      request: new Request(
        `https://ghostbuild.dev/api/cloudflare/connection?deploymentSecurityCursor=${firstBody.deploymentSecurity.nextCursor}`,
      ),
      env,
    });
    const continuationBody = await continuationResponse.json<{
      deploymentSecurity: {
        state: string;
        hasMore: boolean;
        items: Array<{ state: string; workerName: string | null }>;
      };
    }>();
    expect(continuationBody.deploymentSecurity).toMatchObject({
      state: 'action_required',
      hasMore: false,
      items: [{ state: 'user_action_required', workerName: 'ghostbuild-026' }],
    });
    expect(preparedSql).toContain('(? IS NULL OR worker_name > ?)');
    expect(preparedSql).not.toContain('OFFSET');
    expect(preparedSql).not.toContain('updated_at DESC');
  });

  it('returns a bounded owner-scoped continuation page', async () => {
    mocks.getAuthSession.mockResolvedValue({ user: { id: 'user-1' } });
    mocks.findConnection.mockResolvedValue({
      id: 'connection-1',
      status: 'active',
      accountName: null,
      aiBillingEnabled: false,
      connectedAt: 100,
    });
    const queries: unknown[][] = [];
    const env = {
      DB: {
        prepare() {
          return {
            bind(...values: unknown[]) {
              queries.push(values);
              return { all: async () => ({ results: [deploymentSecurityRow({ worker_name: 'ghostbuild-next' })] }) };
            },
          };
        },
      },
    } as unknown as Env;

    const response = await cloudflareConnectionStatusAction({
      request: new Request(
        'https://ghostbuild.dev/api/cloudflare/connection?deploymentSecurityCursor=ghostbuild-cursor',
      ),
      env,
    });

    await expect(response.json()).resolves.toMatchObject({
      deploymentSecurity: {
        hasMore: false,
        nextCursor: null,
        items: [{ workerName: 'ghostbuild-next' }],
      },
    });
    expect(queries[1]?.slice(0, 4)).toEqual(['user-1', 'connection-1', 'ghostbuild-cursor', 'ghostbuild-cursor']);
  });

  it('rejects malformed or repeated deployment security cursors before querying inventory', async () => {
    mocks.getAuthSession.mockResolvedValue({ user: { id: 'user-1' } });
    mocks.findConnection.mockResolvedValue({
      id: 'connection-1',
      status: 'active',
      accountName: null,
      aiBillingEnabled: false,
      connectedAt: 100,
    });
    const prepare = vi.fn();
    const env = { DB: { prepare } } as unknown as Env;

    for (const query of [
      'deploymentSecurityCursor=../worker',
      'deploymentSecurityCursor=worker-a&deploymentSecurityCursor=worker-b',
    ]) {
      const response = await cloudflareConnectionStatusAction({
        request: new Request(`https://ghostbuild.dev/api/cloudflare/connection?${query}`),
        env,
      });
      expect(response.status).toBe(400);
    }
    expect(prepare).not.toHaveBeenCalled();
  });

  it('surfaces known action items while another inventory row is pending discovery', async () => {
    mocks.getAuthSession.mockResolvedValue({ user: { id: 'user-1' } });
    mocks.findConnection.mockResolvedValue({
      id: 'connection-1',
      status: 'active',
      accountName: null,
      aiBillingEnabled: false,
      connectedAt: 100,
    });
    const rows = [
      deploymentSecurityRow({ last_checked_at: 0, worker_name: 'ghostbuild-pending' }),
      deploymentSecurityRow({ status: 'drifted', worker_name: 'ghostbuild-requires-action' }),
    ];
    const env = {
      DB: {
        prepare() {
          return { bind: () => ({ all: async () => ({ results: rows }) }) };
        },
      },
    } as unknown as Env;

    const response = await cloudflareConnectionStatusAction({
      request: new Request('https://ghostbuild.dev/api/cloudflare/connection'),
      env,
    });

    await expect(response.json()).resolves.toMatchObject({
      deploymentSecurity: {
        state: 'action_required',
        items: [{ state: 'user_action_required', workerName: 'ghostbuild-requires-action' }],
      },
    });
  });

  it('keeps the connection usable while its deployment inventory is temporarily unavailable', async () => {
    mocks.getAuthSession.mockResolvedValue({ user: { id: 'user-1' } });
    mocks.findConnection.mockResolvedValue({
      id: 'connection-1',
      status: 'active',
      accountName: null,
      aiBillingEnabled: false,
      connectedAt: 100,
    });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const env = {
      DB: {
        prepare() {
          throw new Error('inventory unavailable');
        },
      },
    } as unknown as Env;

    const response = await cloudflareConnectionStatusAction({
      request: new Request('https://ghostbuild.dev/api/cloudflare/connection'),
      env,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      deploymentSecurity: { state: 'checking', items: [], hasMore: false, nextCursor: null },
    });
    errorLog.mockRestore();
  });

  it.each([
    { label: 'empty', rows: [] },
    { label: 'pending discovery', rows: [deploymentSecurityRow({ last_checked_at: 0 })] },
  ])('reports checking for an $label inventory without exposing an unverified item', async ({ rows }) => {
    mocks.getAuthSession.mockResolvedValue({ user: { id: 'user-1' } });
    mocks.findConnection.mockResolvedValue({
      id: 'connection-1',
      status: 'active',
      accountName: null,
      aiBillingEnabled: false,
      connectedAt: 100,
    });
    const env = {
      DB: {
        prepare() {
          return { bind: () => ({ all: async () => ({ results: rows }) }) };
        },
      },
    } as unknown as Env;

    const response = await cloudflareConnectionStatusAction({
      request: new Request('https://ghostbuild.dev/api/cloudflare/connection'),
      env,
    });

    await expect(response.json()).resolves.toMatchObject({
      deploymentSecurity: { state: 'checking', items: [], hasMore: false, nextCursor: null },
    });
  });

  it('starts OAuth before any local session exists and keeps only a same-origin return path', async () => {
    const database = oauthDatabase();
    const orchestrator = fakeOrchestrator();
    const response = await startCloudflareConnectionAction({
      request: new Request('https://ghostbuild.dev/api/cloudflare/connection/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://ghostbuild.dev',
          'CF-Connecting-IP': '192.0.2.10',
        },
        body: JSON.stringify({ callbackURL: 'https://ghostbuild.dev/create/example?tab=code' }),
      }),
      env: database.env,
      orchestrator,
    });
    expect(response.status).toBe(201);
    expect(response.headers.get('set-cookie')).toContain('ghostbuild_oauth_state=');
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(response.headers.get('set-cookie')).toContain('SameSite=Lax');
    expect(database.limit).toHaveBeenCalledWith({ key: '192.0.2.10' });
    expect(database.state?.returnTo).toBe('/create/example?tab=code');
    expect(orchestrator.startConnection).toHaveBeenCalledWith({
      returnUrl: expect.stringContaining('/connect/return?state='),
      requestedCapabilities: ['workers', 'containers', 'd1', 'r2', 'durable_objects', 'workers_ai'],
    });
  });

  it('rejects cross-origin OAuth initiation', async () => {
    const orchestrator = fakeOrchestrator();
    const database = oauthDatabase();
    const response = await startCloudflareConnectionAction({
      request: new Request('https://ghostbuild.dev/api/cloudflare/connection/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
        body: '{}',
      }),
      env: database.env,
      orchestrator,
    });

    expect(response.status).toBe(403);
    expect(database.limit).not.toHaveBeenCalled();
    expect(orchestrator.startConnection).not.toHaveBeenCalled();
  });

  it('rate limits OAuth initiation before parsing the body or starting provider work', async () => {
    const database = oauthDatabase({ rateLimitSuccess: false });
    const orchestrator = fakeOrchestrator();
    const response = await startCloudflareConnectionAction({
      request: new Request('https://ghostbuild.dev/api/cloudflare/connection/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://ghostbuild.dev',
          'CF-Connecting-IP': '192.0.2.11',
        },
        body: '{not-valid-json',
      }),
      env: database.env,
      orchestrator,
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(database.limit).toHaveBeenCalledWith({ key: '192.0.2.11' });
    expect(orchestrator.startConnection).not.toHaveBeenCalled();
    expect(database.state).toBeNull();
  });

  it('rejects an oversized OAuth initiation before parsing or provider work', async () => {
    const orchestrator = fakeOrchestrator();
    const response = await startCloudflareConnectionAction({
      request: new Request('https://ghostbuild.dev/api/cloudflare/connection/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://ghostbuild.dev' },
        body: JSON.stringify({ callbackURL: `https://ghostbuild.dev/${'a'.repeat(5_000)}` }),
      }),
      env: oauthDatabase().env,
      orchestrator,
    });

    expect(response.status).toBe(413);
    expect(orchestrator.startConnection).not.toHaveBeenCalled();
  });

  it('classifies an invalid OAuth initiation payload as a client request error', async () => {
    const orchestrator = fakeOrchestrator();
    const response = await startCloudflareConnectionAction({
      request: new Request('https://ghostbuild.dev/api/cloudflare/connection/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://ghostbuild.dev' },
        body: JSON.stringify({ callbackURL: 'not-a-url' }),
      }),
      env: oauthDatabase().env,
      orchestrator,
    });

    expect(response.status).toBe(400);
    expect(orchestrator.startConnection).not.toHaveBeenCalled();
  });

  it('rejects a same-origin callback path that would resolve as a scheme-relative redirect', async () => {
    const database = oauthDatabase();
    const response = await startCloudflareConnectionAction({
      request: new Request('https://ghostbuild.dev/api/cloudflare/connection/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://ghostbuild.dev' },
        body: JSON.stringify({ callbackURL: 'https://ghostbuild.dev//attacker.example/landing' }),
      }),
      env: database.env,
      orchestrator: fakeOrchestrator(),
    });

    expect(response.status).toBe(201);
    expect(database.state?.returnTo).toBe('/');
  });

  it('revalidates a persisted return path before constructing the completion redirect', async () => {
    const database = oauthDatabase();
    const start = await startCloudflareConnectionAction({
      request: new Request('https://ghostbuild.dev/api/cloudflare/connection/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://ghostbuild.dev' },
        body: '{}',
      }),
      env: database.env,
      orchestrator: fakeOrchestrator(),
    });
    database.state!.returnTo = '//attacker.example/landing';
    const stateCookie = start.headers.get('set-cookie')!.split(';', 1)[0];

    const response = await completeCloudflareConnectionAction({
      request: new Request(`https://ghostbuild.dev/connect/return?state=${database.state!.id}&code=code-1`, {
        headers: { cookie: stateCookie },
      }),
      env: database.env,
      orchestrator: fakeOrchestrator(),
    });

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://ghostbuild.dev/');
  });

  it('completes OAuth, activates the selected account, and creates the app session', async () => {
    const database = oauthDatabase();
    const start = await startCloudflareConnectionAction({
      request: new Request('https://ghostbuild.dev/api/cloudflare/connection/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://ghostbuild.dev' },
        body: JSON.stringify({ callbackURL: 'https://ghostbuild.dev/settings' }),
      }),
      env: database.env,
      orchestrator: fakeOrchestrator(),
    });
    expect(start.status).toBe(201);
    const state = database.state!.id;
    const stateCookie = start.headers.get('set-cookie')!.split(';', 1)[0];
    const response = await completeCloudflareConnectionAction({
      request: new Request(`https://ghostbuild.dev/connect/return?state=${state}&code=code-1`, {
        headers: { cookie: stateCookie },
      }),
      env: database.env,
      orchestrator: fakeOrchestrator(),
    });

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://ghostbuild.dev/settings');
    expect(response.headers.get('set-cookie')).toContain('ghostbuild_session=opaque');
    expect(mocks.upsertCloudflareUser).toHaveBeenCalledWith(
      database.env.DB,
      expect.objectContaining({ subject: 'cf-user-1', email: 'person@example.com' }),
      'User Cloudflare',
    );
    expect(mocks.activateConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        accountId: 'account-1',
        credentialHandle: 'credential-1',
        expectedGeneration: null,
      }),
    );
    expect(mocks.prepareAuthSession).toHaveBeenCalledWith('user-1', expect.any(Request));
    expect(mocks.createAuthSession).toHaveBeenCalledWith(
      database.env,
      expect.objectContaining({ id: 'session-1', tokenHash: 'f'.repeat(64) }),
    );
    expect(database.state?.status).toBe('completed');

    const replay = await completeCloudflareConnectionAction({
      request: new Request(`https://ghostbuild.dev/connect/return?state=${state}&code=code-1`, {
        headers: { cookie: stateCookie },
      }),
      env: database.env,
      orchestrator: fakeOrchestrator(),
    });
    expect(replay.status).toBe(404);
  });

  it('rejects an oversized OAuth callback field before provider or persistence work', async () => {
    const database = oauthDatabase();
    const orchestrator = fakeOrchestrator();
    const start = await startCloudflareConnectionAction({
      request: new Request('https://ghostbuild.dev/api/cloudflare/connection/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://ghostbuild.dev' },
        body: '{}',
      }),
      env: database.env,
      orchestrator,
    });
    const stateCookie = start.headers.get('set-cookie')!.split(';', 1)[0];

    const response = await completeCloudflareConnectionAction({
      request: new Request(
        `https://ghostbuild.dev/connect/return?state=${database.state!.id}&code=${'a'.repeat(4_097)}`,
        { headers: { cookie: stateCookie } },
      ),
      env: database.env,
      orchestrator,
    });

    expect(response.status).toBe(400);
    expect(database.state?.status).toBe('pending');
    expect(orchestrator.completeConnection).not.toHaveBeenCalled();
    expect(mocks.createAuthSession).not.toHaveBeenCalled();
  });

  it('finishes the callback when the exact state completion committed before acknowledgement failed', async () => {
    const database = oauthDatabase({
      completionErrorAfterCommit: new Error('state completion acknowledgement failed'),
    });
    const orchestrator = fakeOrchestrator();
    const start = await startCloudflareConnectionAction({
      request: new Request('https://ghostbuild.dev/api/cloudflare/connection/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://ghostbuild.dev' },
        body: '{}',
      }),
      env: database.env,
      orchestrator,
    });
    const stateCookie = start.headers.get('set-cookie')!.split(';', 1)[0];

    const response = await completeCloudflareConnectionAction({
      request: new Request(`https://ghostbuild.dev/connect/return?state=${database.state!.id}&code=code-1`, {
        headers: { cookie: stateCookie },
      }),
      env: database.env,
      orchestrator,
    });

    expect(response.status).toBe(303);
    expect(database.state?.status).toBe('completed');
    expect(database.exactCompletionRead).toHaveBeenCalledTimes(1);
    expect(orchestrator.completeConnection).toHaveBeenCalledTimes(1);
    expect(mocks.createAuthSession).toHaveBeenCalledTimes(1);
  });

  it('continues when the exact authenticated-user checkpoint committed before acknowledgement failed', async () => {
    const database = oauthDatabase({
      checkpointErrorAfterCommit: new Error('authentication checkpoint acknowledgement failed'),
    });
    const orchestrator = fakeOrchestrator();
    const start = await startCloudflareConnectionAction({
      request: new Request('https://ghostbuild.dev/api/cloudflare/connection/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://ghostbuild.dev' },
        body: '{}',
      }),
      env: database.env,
      orchestrator,
    });
    const stateCookie = start.headers.get('set-cookie')!.split(';', 1)[0];

    const response = await completeCloudflareConnectionAction({
      request: new Request(`https://ghostbuild.dev/connect/return?state=${database.state!.id}&code=code-1`, {
        headers: { cookie: stateCookie },
      }),
      env: database.env,
      orchestrator,
    });

    expect(response.status).toBe(303);
    expect(database.state?.status).toBe('completed');
    expect(database.exactCompletionRead).toHaveBeenCalledTimes(1);
    expect(orchestrator.completeConnection).toHaveBeenCalledTimes(1);
  });

  it('rejects an acknowledgement failure for a mismatched authenticated-user checkpoint', async () => {
    const database = oauthDatabase({
      checkpointErrorAfterCommit: new Error('authentication checkpoint acknowledgement failed'),
      checkpointMismatchAfterCommit: true,
    });
    const orchestrator = fakeOrchestrator();
    const start = await startCloudflareConnectionAction({
      request: new Request('https://ghostbuild.dev/api/cloudflare/connection/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://ghostbuild.dev' },
        body: '{}',
      }),
      env: database.env,
      orchestrator,
    });
    const stateCookie = start.headers.get('set-cookie')!.split(';', 1)[0];

    const response = await completeCloudflareConnectionAction({
      request: new Request(`https://ghostbuild.dev/connect/return?state=${database.state!.id}&code=code-1`, {
        headers: { cookie: stateCookie },
      }),
      env: database.env,
      orchestrator,
    });

    expect(response.status).toBe(500);
    expect(database.state?.status).toBe('pending');
    expect(database.exactCompletionRead).toHaveBeenCalledTimes(1);
    expect(mocks.createAuthSession).not.toHaveBeenCalled();
  });

  it('rejects a state completion acknowledgement failure when the committed state does not match exactly', async () => {
    const database = oauthDatabase({
      completionErrorAfterCommit: new Error('state completion acknowledgement failed'),
      completionMismatchAfterCommit: true,
    });
    const orchestrator = fakeOrchestrator();
    const start = await startCloudflareConnectionAction({
      request: new Request('https://ghostbuild.dev/api/cloudflare/connection/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://ghostbuild.dev' },
        body: '{}',
      }),
      env: database.env,
      orchestrator,
    });
    const stateCookie = start.headers.get('set-cookie')!.split(';', 1)[0];

    const response = await completeCloudflareConnectionAction({
      request: new Request(`https://ghostbuild.dev/connect/return?state=${database.state!.id}&code=code-1`, {
        headers: { cookie: stateCookie },
      }),
      env: database.env,
      orchestrator,
    });

    expect(response.status).toBe(500);
    expect(database.state?.status).toBe('completed');
    expect(database.exactCompletionRead).toHaveBeenCalledTimes(1);
    expect(orchestrator.completeConnection).toHaveBeenCalledTimes(1);
  });

  it('resumes a session persistence failure without replaying the one-time provider exchange', async () => {
    const database = oauthDatabase();
    const orchestrator = fakeOrchestrator();
    mocks.findConnection.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'connection-1',
      userId: 'user-1',
      accountId: 'account-1',
      accountName: 'User Cloudflare',
      status: 'active',
      credentialHandle: 'credential-1',
      grantedScopes: ['workers'],
      aiBillingEnabled: false,
      connectedAt: 100,
      updatedAt: 100,
      generation: 1,
    });
    const start = await startCloudflareConnectionAction({
      request: new Request('https://ghostbuild.dev/api/cloudflare/connection/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://ghostbuild.dev' },
        body: '{}',
      }),
      env: database.env,
      orchestrator,
    });
    const stateCookie = start.headers.get('set-cookie')!.split(';', 1)[0];
    mocks.createAuthSession.mockRejectedValueOnce(new Error('session persistence failed'));

    const response = await completeCloudflareConnectionAction({
      request: new Request(`https://ghostbuild.dev/connect/return?state=${database.state!.id}&code=code-1`, {
        headers: { cookie: stateCookie },
      }),
      env: database.env,
      orchestrator,
    });

    expect(response.status).toBe(500);
    expect(database.state?.status).toBe('pending');
    expect(database.state?.authenticatedUserId).toBe('user-1');
    expect(database.completeStateWrite).not.toHaveBeenCalled();
    expect(orchestrator.completeConnection).toHaveBeenCalledTimes(1);

    const retry = await completeCloudflareConnectionAction({
      request: new Request(`https://ghostbuild.dev/connect/return?state=${database.state!.id}&code=code-1`, {
        headers: { cookie: stateCookie },
      }),
      env: database.env,
      orchestrator,
    });

    expect(retry.status).toBe(303);
    expect(database.state?.status).toBe('completed');
    expect(orchestrator.completeConnection).toHaveBeenCalledTimes(1);
    expect(mocks.activateConnection).toHaveBeenCalledTimes(1);
  });

  it('rejects a callback that was not initiated by the same browser', async () => {
    const database = oauthDatabase();
    await startCloudflareConnectionAction({
      request: new Request('https://ghostbuild.dev/api/cloudflare/connection/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://ghostbuild.dev' },
        body: '{}',
      }),
      env: database.env,
      orchestrator: fakeOrchestrator(),
    });
    const state = database.state!.id;

    const response = await completeCloudflareConnectionAction({
      request: new Request(`https://ghostbuild.dev/connect/return?state=${state}&code=code-1`),
      env: database.env,
      orchestrator: fakeOrchestrator(),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('browser state') });
    expect(mocks.createAuthSession).not.toHaveBeenCalled();
  });

  it('fails a competing callback and cleans up only through a reference-aware credential delete', async () => {
    const database = oauthDatabase();
    const start = await startCloudflareConnectionAction({
      request: new Request('https://ghostbuild.dev/api/cloudflare/connection/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://ghostbuild.dev' },
        body: '{}',
      }),
      env: database.env,
      orchestrator: fakeOrchestrator(),
    });
    const state = database.state!.id;
    const stateCookie = start.headers.get('set-cookie')!.split(';', 1)[0];
    mocks.findConnection
      .mockResolvedValueOnce({ credentialHandle: 'credential-old', generation: 4, status: 'active' })
      .mockResolvedValueOnce({
        id: 'connection-1',
        userId: 'user-1',
        accountId: 'different-account',
        accountName: 'Different account',
        status: 'active',
        credentialHandle: 'credential-winner',
        grantedScopes: ['workers', 'd1', 'r2', 'durable_objects', 'workers_ai'],
        aiBillingEnabled: true,
        connectedAt: 101,
        updatedAt: 101,
        generation: 5,
      });
    mocks.activateConnection.mockRejectedValueOnce(new mocks.CloudflareConnectionChangedError());

    const response = await completeCloudflareConnectionAction({
      request: new Request(`https://ghostbuild.dev/connect/return?state=${state}&code=code-1`, {
        headers: { cookie: stateCookie },
      }),
      env: database.env,
      orchestrator: fakeOrchestrator(),
    });

    expect(response.status).toBe(500);
    expect(mocks.activateConnection).toHaveBeenCalledWith(expect.objectContaining({ expectedGeneration: 4 }));
    expect(mocks.vault.deleteIfUnreferenced).toHaveBeenCalledWith('credential-1');
    expect(mocks.vault.deleteIfUnreferenced).not.toHaveBeenCalledWith('credential-old');
    expect(database.state?.status).toBe('pending');
    expect(mocks.createAuthSession).not.toHaveBeenCalled();
  });

  it('adopts an equivalent concurrent connection winner after a raced user callback', async () => {
    const database = oauthDatabase();
    const start = await startCloudflareConnectionAction({
      request: new Request('https://ghostbuild.dev/api/cloudflare/connection/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://ghostbuild.dev' },
        body: '{}',
      }),
      env: database.env,
      orchestrator: fakeOrchestrator(),
    });
    const stateCookie = start.headers.get('set-cookie')!.split(';', 1)[0];
    mocks.upsertCloudflareUser.mockResolvedValueOnce({
      id: 'user-1',
      name: 'Person',
      email: 'person@example.com',
      image: null,
    });
    mocks.findConnection.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'connection-winner',
      userId: 'user-1',
      accountId: 'account-1',
      accountName: 'User Cloudflare',
      status: 'active',
      credentialHandle: 'credential-winner',
      grantedScopes: ['workers', 'd1', 'r2', 'durable_objects', 'workers_ai'],
      aiBillingEnabled: true,
      connectedAt: 101,
      updatedAt: 101,
      generation: 1,
    });
    mocks.activateConnection.mockRejectedValueOnce(new mocks.CloudflareConnectionChangedError());

    const response = await completeCloudflareConnectionAction({
      request: new Request(`https://ghostbuild.dev/connect/return?state=${database.state!.id}&code=code-1`, {
        headers: { cookie: stateCookie },
      }),
      env: database.env,
      orchestrator: fakeOrchestrator(),
    });

    expect(response.status).toBe(303);
    expect(database.state?.authenticatedUserId).toBe('user-1');
    expect(database.state?.status).toBe('completed');
    expect(mocks.vault.deleteIfUnreferenced).toHaveBeenCalledWith('credential-1');
    expect(mocks.createAuthSession).toHaveBeenCalledOnce();
  });

  it('cleans up a superseded callback credential only after the new handle is active', async () => {
    const database = oauthDatabase();
    const start = await startCloudflareConnectionAction({
      request: new Request('https://ghostbuild.dev/api/cloudflare/connection/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://ghostbuild.dev' },
        body: '{}',
      }),
      env: database.env,
      orchestrator: fakeOrchestrator(),
    });
    const stateCookie = start.headers.get('set-cookie')!.split(';', 1)[0];
    mocks.findConnection.mockResolvedValueOnce({ credentialHandle: 'credential-old', generation: 4, status: 'active' });
    mocks.activateConnection.mockResolvedValueOnce({
      id: 'connection-1',
      userId: 'user-1',
      accountId: 'account-1',
      accountName: 'User Cloudflare',
      status: 'active',
      credentialHandle: 'credential-1',
      grantedScopes: ['workers'],
      aiBillingEnabled: false,
      connectedAt: 100,
      updatedAt: 100,
      generation: 5,
    });

    const response = await completeCloudflareConnectionAction({
      request: new Request(`https://ghostbuild.dev/connect/return?state=${database.state!.id}&code=code-1`, {
        headers: { cookie: stateCookie },
      }),
      env: database.env,
      orchestrator: fakeOrchestrator(),
    });

    expect(response.status).toBe(303);
    expect(mocks.activateConnection.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.vault.deleteIfUnreferenced.mock.invocationCallOrder[0],
    );
    expect(mocks.vault.deleteIfUnreferenced).toHaveBeenCalledWith('credential-old');
    expect(mocks.vault.deleteIfUnreferenced).not.toHaveBeenCalledWith('credential-1');
  });
});

function fakeOrchestrator(): CloudflareOrchestrator {
  return {
    startConnection: vi.fn(async () => ({
      sessionId: 'provider-session',
      authorizationUrl: 'https://dash.cloudflare.com/oauth2/auth?client_id=test',
      expiresAt: Date.now() + 60_000,
    })),
    completeConnection: vi.fn(async () => ({
      user: {
        subject: 'cf-user-1',
        email: 'person@example.com',
        name: 'Person',
        picture: null,
      },
      accountId: 'account-1',
      accountName: 'User Cloudflare',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      accessTokenExpiresAt: Date.now() + 3_600_000,
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

function deploymentSecurityRow(
  overrides: Partial<{
    is_managed: number;
    deployment_id: string | null;
    chat_id: string | null;
    production_url: string | null;
    status: 'current' | 'legacy_candidate' | 'drifted' | 'unreachable' | 'not_found';
    expected_template_source_sha256: string | null;
    expected_security_baseline_version: number | null;
    expected_security_boundary_sha256: string | null;
    last_checked_at: number;
    worker_name: string;
  }> = {},
) {
  return {
    is_managed: 1,
    deployment_id: 'deployment-1',
    chat_id: 'chat-1',
    production_url: 'https://app.example.com',
    status: 'legacy_candidate' as const,
    expected_template_source_sha256: null,
    expected_security_baseline_version: null,
    expected_security_boundary_sha256: null,
    last_checked_at: 1_700_000_000_000,
    worker_name: 'ghostbuild-deployment-1',
    ...overrides,
  };
}

function oauthDatabase(
  options: {
    rateLimitSuccess?: boolean;
    checkpointErrorAfterCommit?: Error;
    checkpointMismatchAfterCommit?: boolean;
    completionErrorAfterCommit?: Error;
    completionMismatchAfterCommit?: boolean;
  } = {},
) {
  type State = {
    id: string;
    providerSessionId: string;
    returnTo: string;
    status: 'pending' | 'completed' | 'expired';
    expiresAt: number;
    authenticatedUserId: string | null;
    updatedAt: number;
  };
  let state: State | null = null;
  const limit = vi.fn(async () => ({ success: options.rateLimitSuccess ?? true }));
  const completeStateWrite = vi.fn();
  const exactCompletionRead = vi.fn();
  const db = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            first: async () => {
              if (!sql.includes('FROM cloudflare_oauth_states') || !state) {
                return null;
              }
              if (sql.includes('status, expires_at, authenticated_user_id, updated_at')) {
                exactCompletionRead(...values);
                if (values[0] !== state.id) {
                  return null;
                }
                return {
                  provider_session_id: state.providerSessionId,
                  return_to: state.returnTo,
                  status: state.status,
                  expires_at: state.expiresAt,
                  authenticated_user_id: state.authenticatedUserId,
                  updated_at: state.updatedAt,
                };
              }
              if (state.status !== 'pending' || values[0] !== state.id) {
                return null;
              }
              return {
                provider_session_id: state.providerSessionId,
                return_to: state.returnTo,
                expires_at: state.expiresAt,
                authenticated_user_id: state.authenticatedUserId,
              };
            },
            run: async () => {
              if (sql.includes('INSERT INTO cloudflare_oauth_states')) {
                state = {
                  id: values[0] as string,
                  providerSessionId: values[1] as string,
                  returnTo: values[2] as string,
                  status: 'pending',
                  expiresAt: values[3] as number,
                  authenticatedUserId: null,
                  updatedAt: values[5] as number,
                };
              } else if (sql.includes('SET authenticated_user_id') && state) {
                const matches =
                  state.status === 'pending' &&
                  state.authenticatedUserId === null &&
                  values[2] === state.id &&
                  values[3] === state.providerSessionId &&
                  values[4] === state.returnTo &&
                  values[5] === state.expiresAt;
                if (!matches) {
                  return { success: true, meta: { changes: 0 } };
                }
                state = {
                  ...state,
                  authenticatedUserId: values[0] as string,
                  updatedAt: (values[1] as number) + (options.checkpointMismatchAfterCommit ? 1 : 0),
                };
                if (options.checkpointErrorAfterCommit) {
                  throw options.checkpointErrorAfterCommit;
                }
              } else if (sql.includes("status = 'completed'") && state) {
                completeStateWrite(...values);
                const matches =
                  state.status === 'pending' &&
                  values[1] === state.id &&
                  values[2] === state.providerSessionId &&
                  values[3] === state.returnTo &&
                  values[4] === state.expiresAt &&
                  values[5] === state.authenticatedUserId;
                if (!matches) {
                  return { success: true, meta: { changes: 0 } };
                }
                state = {
                  ...state,
                  status: 'completed',
                  updatedAt: (values[0] as number) + (options.completionMismatchAfterCommit ? 1 : 0),
                };
                if (options.completionErrorAfterCommit) {
                  throw options.completionErrorAfterCommit;
                }
              } else if (sql.includes("status = 'expired'") && state) {
                state = { ...state, status: 'expired', updatedAt: values[0] as number };
              }
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return {
    env: {
      DB: db,
      CLOUDFLARE_OAUTH_START_RATE_LIMITER: { limit },
      CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(1))),
    } as unknown as Env,
    get state() {
      return state;
    },
    limit,
    completeStateWrite,
    exactCompletionRead,
  };
}
