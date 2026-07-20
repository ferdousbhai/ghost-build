import { describe, expect, test, vi } from 'vitest';
import { finalizeApplicationResponse, withApplicationSecurityHeaders } from '../template/src/application-response';

describe('generated application response boundary', () => {
  test('adds the production application header baseline', () => {
    const response = withApplicationSecurityHeaders(
      new Response('app', { headers: { 'X-App': 'preserved' } }),
      new Request('https://app.example/'),
    );

    expect(response.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(response.headers.get('Cross-Origin-Embedder-Policy')).toBe('credentialless');
    expect(response.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('X-App')).toBe('preserved');
  });

  test('allows the credentialless WebContainer host to remain frameable for preview', () => {
    const response = withApplicationSecurityHeaders(
      new Response('preview'),
      new Request('https://preview-id.local-credentialless.webcontainer-api.io/'),
    );

    expect(response.headers.get('X-Frame-Options')).toBeNull();
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  test('returns an Agent response by identity without wrapping it or fetching the app', async () => {
    const agentResponse = new Response('agent', {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
    });
    const fetchApplication = vi.fn(() => new Response('app'));

    const result = await finalizeApplicationResponse(
      new Request('https://app.example/agent'),
      agentResponse,
      fetchApplication,
    );

    expect(result).toBe(agentResponse);
    expect(result.headers.get('Upgrade')).toBe('websocket');
    expect(fetchApplication).not.toHaveBeenCalled();
  });
});
