import { describe, expect, test, vi } from 'vitest';
import {
  CloudflareOAuthError,
  CloudflareOAuthOrchestrator,
  REQUIRED_CLOUDFLARE_OAUTH_SCOPES,
} from './cloudflare-oauth-orchestrator';

const scopes = REQUIRED_CLOUDFLARE_OAUTH_SCOPES.join(' ');
const config = { clientId: 'client-1', clientSecret: 'client-secret', scopes };

describe('CloudflareOAuthOrchestrator', () => {
  test('starts authorization code + PKCE with server-owned state and no secret in the browser URL', async () => {
    const orchestrator = new CloudflareOAuthOrchestrator(config);
    const result = await orchestrator.startConnection({
      userId: 'user-1',
      userEmail: 'person@example.com',
      returnUrl: 'https://ghostbuild.dev/api/cloudflare/connection/callback?state=00000000-0000-4000-8000-000000000001',
      requestedCapabilities: ['workers', 'd1', 'r2', 'durable_objects', 'workers_ai'],
    });
    const url = new URL(result.authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://dash.cloudflare.com/oauth2/auth');
    expect(url.searchParams.get('response_mode')).toBeNull();
    expect(url.searchParams.get('state')).toBe('00000000-0000-4000-8000-000000000001');
    expect(url.searchParams.get('redirect_uri')).toBe('https://ghostbuild.dev/api/cloudflare/connection/callback');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe(`${scopes} offline_access`);
    expect(result.authorizationUrl).not.toContain('client-secret');
    expect(JSON.parse(result.sessionId)).toMatchObject({
      redirectUri: 'https://ghostbuild.dev/api/cloudflare/connection/callback',
    });
  });

  test('fails closed when a required resource scope is not configured', async () => {
    const orchestrator = new CloudflareOAuthOrchestrator({
      ...config,
      scopes: REQUIRED_CLOUDFLARE_OAUTH_SCOPES.filter((scope) => scope !== 'workers-r2.write').join(' '),
    });
    await expect(
      orchestrator.startConnection({
        userId: 'user-1',
        userEmail: 'person@example.com',
        returnUrl:
          'https://ghostbuild.dev/api/cloudflare/connection/callback?state=00000000-0000-4000-8000-000000000001',
        requestedCapabilities: ['workers'],
      }),
    ).rejects.toThrow('workers-r2.write');
  });

  test('exchanges the callback code and requires exactly one authorized account', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ access_token: 'oauth-access-token', refresh_token: 'oauth-refresh-token', expires_in: 3600 }),
      )
      .mockResolvedValueOnce(Response.json({ success: true, result: [{ id: 'account-1', name: 'User account' }] }));
    const orchestrator = new CloudflareOAuthOrchestrator(config, request);
    const challenge = await orchestrator.startConnection({
      userId: 'user-1',
      userEmail: 'person@example.com',
      returnUrl: 'https://ghostbuild.dev/api/cloudflare/connection/callback?state=00000000-0000-4000-8000-000000000001',
      requestedCapabilities: ['workers', 'd1', 'r2', 'durable_objects', 'workers_ai'],
    });
    await expect(
      orchestrator.completeConnection({
        providerSessionId: challenge.sessionId,
        callbackUrl:
          'https://ghostbuild.dev/api/cloudflare/connection/callback?state=00000000-0000-4000-8000-000000000001&code=code-1',
      }),
    ).resolves.toEqual({
      accountId: 'account-1',
      accountName: 'User account',
      accessToken: 'oauth-access-token',
      refreshToken: 'oauth-refresh-token',
      accessTokenExpiresAt: expect.any(Number),
      grantedCapabilities: ['workers', 'd1', 'r2', 'durable_objects', 'workers_ai'],
    });
    expect(request).toHaveBeenNthCalledWith(
      1,
      'https://dash.cloudflare.com/oauth2/token',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: `Basic ${btoa('client-1:client-secret')}` }),
      }),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      'https://api.cloudflare.com/client/v4/accounts?per_page=2',
      expect.objectContaining({ headers: { authorization: 'Bearer oauth-access-token' } }),
    );
    expect(request.mock.contexts).toEqual([undefined, undefined]);
  });

  test('rejects multiple-account grants instead of guessing which account pays', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ access_token: 'oauth-access-token', refresh_token: 'oauth-refresh-token' }),
      )
      .mockResolvedValueOnce(Response.json({ success: true, result: [{ id: 'one' }, { id: 'two' }] }));
    const orchestrator = new CloudflareOAuthOrchestrator(config, request);
    const challenge = await orchestrator.startConnection({
      userId: 'user-1',
      userEmail: 'person@example.com',
      returnUrl: 'https://ghostbuild.dev/api/cloudflare/connection/callback?state=00000000-0000-4000-8000-000000000001',
      requestedCapabilities: ['workers'],
    });
    await expect(
      orchestrator.completeConnection({
        providerSessionId: challenge.sessionId,
        callbackUrl: 'https://ghostbuild.dev/api/cloudflare/connection/callback?code=code-1',
      }),
    ).rejects.toBeInstanceOf(CloudflareOAuthError);
  });

  test('rejects an access-only grant that cannot be refreshed', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ access_token: 'oauth-access-token' }));
    const orchestrator = new CloudflareOAuthOrchestrator(config, request);
    const challenge = await orchestrator.startConnection({
      userId: 'user-1',
      userEmail: 'person@example.com',
      returnUrl: 'https://ghostbuild.dev/api/cloudflare/connection/callback?state=00000000-0000-4000-8000-000000000001',
      requestedCapabilities: ['workers'],
    });
    await expect(
      orchestrator.completeConnection({
        providerSessionId: challenge.sessionId,
        callbackUrl: 'https://ghostbuild.dev/api/cloudflare/connection/callback?code=code-1',
      }),
    ).rejects.toThrow('refresh token');
  });
});
