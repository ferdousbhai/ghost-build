import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSandbox = vi.hoisted(() => vi.fn());
const resolvePreviewAccess = vi.hoisted(() => vi.fn());

vi.mock('@cloudflare/sandbox', () => ({ getSandbox }));
vi.mock('~/lib/.server/cloudflare/builder-preview-repository', () => ({ resolvePreviewAccess }));

import { matchPreviewRequest, previewAction } from './previews';

const previewId = '123e4567-e89b-42d3-a456-426614174000';
const accessToken = 'A'.repeat(43);

describe('remote preview endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolvePreviewAccess.mockResolvedValue({
      id: previewId,
      ownerId: 'owner-a',
      agentName: 'agent-a',
      sandboxId: 'sandbox-a',
      workspaceRevision: 12,
      snapshotRevision: 'snapshot-sha',
      port: 4173,
      expiresAt: Date.now() + 60_000,
    });
  });

  it('accepts only opaque server-derived preview identifiers and capabilities', () => {
    expect(matchPreviewRequest(`/api/previews/${previewId}/${accessToken}/assets/app.js`)).toEqual({
      previewId,
      accessToken,
      path: 'assets/app.js',
    });
    expect(matchPreviewRequest(`/api/previews/${previewId}/short/`)).toBeNull();
    expect(matchPreviewRequest('/api/previews/not-a-preview/token/')).toBeNull();
  });

  it.each([
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/138 Mobile',
  ])('serves a revision-bound HTTPS preview to a mobile browser', async (userAgent) => {
    const containerFetch = vi.fn(
      async (_url: string, _init: RequestInit, _port: number) =>
        new Response('<html>preview</html>', {
          headers: {
            'Content-Type': 'text/html',
            'Set-Cookie': 'untrusted=value',
          },
        }),
    );
    getSandbox.mockReturnValue({ containerFetch });

    const response = await previewAction({
      request: new Request(`https://ghostbuild.dev/api/previews/${previewId}/${accessToken}/`, {
        headers: { Cookie: 'ghostbuild_session=secret', 'User-Agent': userAgent },
      }),
      env: { DB: {}, DeploymentSandbox: {} } as Env,
      previewId,
      accessToken,
      path: '',
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<html>preview</html>');
    expect(response.headers.get('X-Ghostbuild-Preview-Revision')).toBe('12');
    expect(response.headers.get('Set-Cookie')).toBeNull();
    expect(response.headers.get('Cross-Origin-Resource-Policy')).toBe('cross-origin');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('null');
    expect(response.headers.get('Content-Security-Policy')).toContain(
      'sandbox allow-forms allow-modals allow-popups allow-scripts',
    );
    expect(response.headers.get('Content-Security-Policy')).not.toContain('allow-same-origin');
    const forwarded = containerFetch.mock.calls[0]![1];
    expect(new Headers(forwarded.headers).has('cookie')).toBe(false);
    expect(resolvePreviewAccess).toHaveBeenCalledWith(expect.anything(), previewId, accessToken);
  });

  it('does not reveal whether a different tenant capability exists', async () => {
    resolvePreviewAccess.mockResolvedValue(null);

    const response = await previewAction({
      request: new Request(`https://ghostbuild.dev/api/previews/${previewId}/${accessToken}/`),
      env: { DB: {}, DeploymentSandbox: {} } as Env,
      previewId,
      accessToken,
      path: '',
    });

    expect(response.status).toBe(404);
    expect(getSandbox).not.toHaveBeenCalled();
  });

  it('rewrites sandbox redirects inside the authenticated preview capability path', async () => {
    getSandbox.mockReturnValue({
      containerFetch: vi.fn(async () => new Response(null, { status: 302, headers: { Location: '/next?q=1' } })),
    });

    const response = await previewAction({
      request: new Request(`https://ghostbuild.dev/api/previews/${previewId}/${accessToken}/`),
      env: { DB: {}, DeploymentSandbox: {} } as Env,
      previewId,
      accessToken,
      path: '',
    });

    expect(response.headers.get('Location')).toBe(`/api/previews/${previewId}/${accessToken}/next?q=1`);
  });

  it('rejects mutating methods before addressing a sandbox', async () => {
    const response = await previewAction({
      request: new Request(`https://ghostbuild.dev/api/previews/${previewId}/${accessToken}/`, { method: 'POST' }),
      env: {} as Env,
      previewId,
      accessToken,
      path: '',
    });

    expect(response.status).toBe(405);
    expect(resolvePreviewAccess).not.toHaveBeenCalled();
  });
});
