import { beforeEach, describe, expect, it, vi } from 'vitest';

const tanstackFetch = vi.hoisted(() => vi.fn());
const getAuthSession = vi.hoisted(() => vi.fn());
const ensureInitialChat = vi.hoisted(() => vi.fn());
const routeAgentRequest = vi.hoisted(() => vi.fn());
const healthAction = vi.hoisted(() => vi.fn());
const cleanupExpiredBuilderPreviewsBestEffort = vi.hoisted(() => vi.fn());
const completeCloudflareConnectionAction = vi.hoisted(() => vi.fn());
const cloudflareConnectionStatusAction = vi.hoisted(() => vi.fn());
const startCloudflareConnectionAction = vi.hoisted(() => vi.fn());
const drainDeferredDataGcBestEffort = vi.hoisted(() => vi.fn());
const pruneCloudflareAuthDataBestEffort = vi.hoisted(() => vi.fn());
const refreshDeploymentSecurityInventoryBestEffort = vi.hoisted(() => vi.fn());
const reconcileChatBackupQuotaBestEffort = vi.hoisted(() => vi.fn());
const reconcileThumbnailQuotaBestEffort = vi.hoisted(() => vi.fn());

vi.mock('@tanstack/react-start/server-entry', () => ({ default: { fetch: tanstackFetch } }));
vi.mock('agents', () => ({ routeAgentRequest }));
vi.mock('./agents/builder-agent', () => ({ BuilderAgent: class {} }));
vi.mock('./lib/.server/auth', () => ({ getAuthSession }));
vi.mock('./lib/.server/cloudflare/deployment-sandbox', () => ({
  ContainerProxy: class {},
  DeploymentSandbox: class {},
}));
vi.mock('./lib/.server/cloudflare/deployment-workflow', () => ({ DeploymentWorkflow: class {} }));
vi.mock('./lib/.server/cloudflare/skill-sync-workflow', () => ({ SkillSyncWorkflow: class {} }));
vi.mock('./lib/cloudflare/data/chat-repository.server', () => ({ ensureInitialChat }));
vi.mock('./lib/cloudflare/data.server', () => ({
  dataAction: vi.fn(),
  initialMessagesAction: vi.fn(),
  storageObjectAction: vi.fn(),
  storeChatAction: vi.fn(),
  uploadThumbnailAction: vi.fn(),
}));
vi.mock('./server-handlers/auth', () => ({ authSessionAction: vi.fn(), signOutAction: vi.fn() }));
vi.mock('./server-handlers/client-telemetry', () => ({ clientTelemetryAction: vi.fn() }));
vi.mock('./server-handlers/cloudflare-integration', () => ({
  CLOUDFLARE_CONNECTION_CALLBACK_METHOD: 'GET',
  cloudflareConnectionStatusAction,
  completeCloudflareConnectionAction,
  startCloudflareConnectionAction,
}));
vi.mock('./server-handlers/deployments', () => ({
  createDeploymentPlanAction: vi.fn(),
  deploymentAction: vi.fn(),
}));
vi.mock('./server-handlers/enhance-prompt', () => ({ enhancePromptAction: vi.fn() }));
vi.mock('./server-handlers/feedback', () => ({ feedbackAction: vi.fn() }));
vi.mock('./server-handlers/health', () => ({ healthAction }));
vi.mock('./server-handlers/version', () => ({ versionAction: vi.fn() }));
vi.mock('./lib/cloudflare/data/deferred-gc.server', () => ({ drainDeferredDataGcBestEffort }));
vi.mock('./lib/cloudflare/data/cloudflare-auth-retention.server', () => ({ pruneCloudflareAuthDataBestEffort }));
vi.mock('./lib/.server/cloudflare/deployment-security-inventory', () => ({
  refreshDeploymentSecurityInventoryBestEffort,
}));
vi.mock('./lib/.server/cloudflare/builder-preview-repository', () => ({
  cleanupExpiredBuilderPreviewsBestEffort,
}));
vi.mock('./server-handlers/previews', () => ({
  matchPreviewRequest: () => null,
  previewAction: vi.fn(),
}));
vi.mock('./lib/cloudflare/data/chat-backup-quota.server', () => ({ reconcileChatBackupQuotaBestEffort }));
vi.mock('./lib/cloudflare/data/thumbnail-quota.server', () => ({ reconcileThumbnailQuotaBestEffort }));

import server from './server';

describe('server Agent routing boundary', () => {
  beforeEach(() => {
    tanstackFetch.mockReset();
    tanstackFetch.mockResolvedValue(new Response('application'));
    getAuthSession.mockReset();
    ensureInitialChat.mockReset();
    routeAgentRequest.mockReset();
    healthAction.mockReset().mockResolvedValue(Response.json({ status: 'ok' }));
    cleanupExpiredBuilderPreviewsBestEffort.mockReset().mockResolvedValue(undefined);
    completeCloudflareConnectionAction.mockReset().mockImplementation(async () => {
      const headers = new Headers({ Location: 'https://ghostbuild.dev/' });
      headers.append('Set-Cookie', 'ghostbuild_session=session; Path=/; HttpOnly; Secure');
      headers.append('Set-Cookie', 'ghostbuild_oauth_state=; Path=/connect/return; Max-Age=0');
      return new Response(null, { status: 303, headers });
    });
    cloudflareConnectionStatusAction.mockReset().mockResolvedValue(Response.json({ connected: true }));
    startCloudflareConnectionAction
      .mockReset()
      .mockResolvedValue(Response.json({ error: 'Invalid request.' }, { status: 400 }));
    drainDeferredDataGcBestEffort.mockReset().mockResolvedValue(undefined);
    pruneCloudflareAuthDataBestEffort.mockReset().mockResolvedValue(undefined);
    refreshDeploymentSecurityInventoryBestEffort.mockReset().mockResolvedValue(undefined);
    reconcileChatBackupQuotaBestEffort.mockReset().mockResolvedValue(undefined);
  });

  it.each([
    '/agents/deployment-sandbox/private',
    '/agents/container-proxy/private',
    '/agents/deployment-workflow/private',
    '/agents/skill-sync-workflow/private',
  ])('rejects a non-BuilderAgent namespace before either application or PartyServer routing: %s', async (pathname) => {
    const response = await server.fetch(new Request(`https://ghostbuild.dev${pathname}`), {} as Env);

    expect(response.status).toBe(404);
    expect(getAuthSession).not.toHaveBeenCalled();
    expect(routeAgentRequest).not.toHaveBeenCalled();
    expect(tanstackFetch).not.toHaveBeenCalled();
  });

  it('leaves ordinary application routes outside the Agent routing boundary', async () => {
    const response = await server.fetch(new Request('https://ghostbuild.dev/not-an-agent'), {} as Env);

    expect(await response.text()).toBe('application');
    expect(response.headers.has('Cross-Origin-Opener-Policy')).toBe(false);
    expect(response.headers.has('Cross-Origin-Embedder-Policy')).toBe(false);
    expect(response.headers.get('Content-Security-Policy')).toBe(
      "base-uri 'self'; frame-ancestors 'none'; object-src 'none'; form-action 'self'",
    );
    expect(response.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(response.headers.get('Strict-Transport-Security')).toBe('max-age=31536000');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(routeAgentRequest).not.toHaveBeenCalled();
    expect(tanstackFetch).toHaveBeenCalledOnce();
  });

  it('applies the application security policy to exact API responses', async () => {
    const response = await server.fetch(new Request('https://ghostbuild.dev/api/health'), {} as Env);

    expect(response.status).toBe(200);
    expect(response.headers.has('Cross-Origin-Opener-Policy')).toBe(false);
    expect(response.headers.has('Cross-Origin-Embedder-Policy')).toBe(false);
    expect(response.headers.get('Content-Security-Policy')).toBe(
      "base-uri 'self'; frame-ancestors 'none'; object-src 'none'; form-action 'self'",
    );
    expect(response.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(response.headers.get('Strict-Transport-Security')).toBe('max-age=31536000');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(healthAction).toHaveBeenCalledOnce();
    expect(tanstackFetch).not.toHaveBeenCalled();
  });

  it('applies the application security policy to router-generated errors', async () => {
    const response = await server.fetch(
      new Request('https://ghostbuild.dev/api/health', { method: 'POST' }),
      {} as Env,
    );

    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(healthAction).not.toHaveBeenCalled();
  });

  it('marks OAuth callback redirects no-store without losing either cookie', async () => {
    const response = await server.fetch(
      new Request('https://ghostbuild.dev/connect/return?state=00000000-0000-4000-8000-000000000001&code=code'),
      {} as Env,
    );

    expect(response.status).toBe(303);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Pragma')).toBe('no-cache');
    expect(response.headers.getSetCookie()).toEqual([
      'ghostbuild_session=session; Path=/; HttpOnly; Secure',
      'ghostbuild_oauth_state=; Path=/connect/return; Max-Age=0',
    ]);
    expect(completeCloudflareConnectionAction).toHaveBeenCalledOnce();
  });

  it.each([
    ['connection status', '/api/cloudflare/connection', 'GET'],
    ['OAuth start errors', '/api/cloudflare/connection/start', 'POST'],
  ])('marks Cloudflare %s responses no-store', async (_label, pathname, method) => {
    const response = await server.fetch(new Request(`https://ghostbuild.dev${pathname}`, { method }), {} as Env);

    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('preserves an explicit application cache policy', async () => {
    healthAction.mockResolvedValueOnce(
      Response.json({ status: 'ok' }, { headers: { 'Cache-Control': 'public, max-age=60' } }),
    );

    const response = await server.fetch(new Request('https://ghostbuild.dev/api/health'), {} as Env);

    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60');
  });

  it('independently enforces the baseline without weakening stricter application CSP or HSTS', async () => {
    tanstackFetch.mockResolvedValueOnce(
      new Response('application', {
        headers: {
          'Content-Security-Policy': "default-src 'none'; script-src 'self'",
          'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
        },
      }),
    );

    const response = await server.fetch(new Request('https://ghostbuild.dev/strict'), {} as Env);

    expect(response.headers.get('Content-Security-Policy')).toBe(
      "default-src 'none'; script-src 'self', base-uri 'self'; frame-ancestors 'none'; object-src 'none'; form-action 'self'",
    );
    expect(response.headers.get('Strict-Transport-Security')).toBe('max-age=63072000; includeSubDomains; preload');
  });

  it('bounds malformed HSTS parsing and preserves non-max-age directives when applying the floor', async () => {
    tanstackFetch.mockResolvedValueOnce(
      new Response('application', {
        headers: {
          'Strict-Transport-Security': `max-age=${'9'.repeat(1_024)}; includeSubDomains; future=value`,
        },
      }),
    );

    const response = await server.fetch(new Request('https://ghostbuild.dev/hsts-floor'), {} as Env);

    expect(response.headers.get('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains; future=value');
  });

  it('normalizes duplicate HSTS max-age directives', async () => {
    tanstackFetch.mockResolvedValueOnce(
      new Response('application', {
        headers: {
          'Strict-Transport-Security': 'max-age=63072000; max-age=0; includeSubDomains',
        },
      }),
    );

    const response = await server.fetch(new Request('https://ghostbuild.dev/duplicate-hsts'), {} as Env);

    expect(response.headers.get('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains');
  });

  it('sequences bounded scheduled maintenance to stay within the outgoing-connection budget', async () => {
    const waitUntil = vi.fn();
    const env = { DB: {} as D1Database } as Env;
    const calls: string[] = [];
    drainDeferredDataGcBestEffort.mockImplementationOnce(async () => {
      calls.push('deferred-data-gc');
    });
    pruneCloudflareAuthDataBestEffort.mockImplementationOnce(async () => {
      calls.push('auth-retention');
    });
    reconcileChatBackupQuotaBestEffort.mockImplementationOnce(async () => {
      calls.push('chat-backup-quota');
    });
    reconcileThumbnailQuotaBestEffort.mockImplementationOnce(async () => {
      calls.push('thumbnail-quota');
    });
    cleanupExpiredBuilderPreviewsBestEffort.mockImplementationOnce(async () => {
      calls.push('builder-previews');
    });
    refreshDeploymentSecurityInventoryBestEffort.mockImplementationOnce(async () => {
      calls.push('deployment-security-inventory');
    });

    server.scheduled({} as ScheduledController, env, { waitUntil } as unknown as ExecutionContext);

    expect(waitUntil).toHaveBeenCalledOnce();
    await waitUntil.mock.calls[0][0];
    expect(calls).toEqual([
      'deferred-data-gc',
      'auth-retention',
      'chat-backup-quota',
      'thumbnail-quota',
      'builder-previews',
      'deployment-security-inventory',
    ]);
    expect(drainDeferredDataGcBestEffort).toHaveBeenCalledOnce();
    expect(pruneCloudflareAuthDataBestEffort).toHaveBeenCalledWith(env.DB);
    expect(refreshDeploymentSecurityInventoryBestEffort).toHaveBeenCalledWith(env);
    expect(reconcileChatBackupQuotaBestEffort).toHaveBeenCalledWith(env);
    expect(reconcileThumbnailQuotaBestEffort).toHaveBeenCalledWith(env);
    expect(cleanupExpiredBuilderPreviewsBestEffort).toHaveBeenCalledWith(env);
  });
});
