import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clientTelemetryAction } from './client-telemetry';

describe('clientTelemetryAction', () => {
  const limit = vi.fn(async () => ({ success: true }));
  const env = { CLIENT_TELEMETRY_RATE_LIMITER: { limit } } as unknown as Env;

  beforeEach(() => {
    limit.mockClear().mockResolvedValue({ success: true });
  });

  it('rejects an oversized streamed body before buffering beyond the limit', async () => {
    const response = await clientTelemetryAction({
      env,
      request: new Request('https://ghostbuild.dev/api/client-telemetry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://ghostbuild.dev' },
        body: JSON.stringify({ kind: 'message', message: 'a'.repeat(70 * 1024) }),
      }),
    });

    expect(response.status).toBe(413);
  });

  it('rejects cross-origin telemetry before consuming rate-limit capacity', async () => {
    const response = await clientTelemetryAction({
      env,
      request: telemetryRequest({ Origin: 'https://attacker.example' }),
    });

    expect(response.status).toBe(403);
    expect(limit).not.toHaveBeenCalled();
  });

  it('rate limits a Cloudflare client source before reading or logging the body', async () => {
    limit.mockResolvedValue({ success: false });

    const response = await clientTelemetryAction({
      env,
      request: telemetryRequest({ 'CF-Connecting-IP': '192.0.2.1' }),
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(limit).toHaveBeenCalledWith({ key: '192.0.2.1' });
  });

  it('preserves valid telemetry handling', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const response = await clientTelemetryAction({ env, request: telemetryRequest() });

    expect(response.status).toBe(204);
    expect(warn).toHaveBeenCalledWith('Ghostbuild client telemetry', {
      kind: 'message',
      event: 'Builder client tool call failed',
    });
    warn.mockRestore();
  });

  it('rejects client-controlled identity, route, and arbitrary extra fields', async () => {
    const response = await clientTelemetryAction({
      env,
      request: telemetryRequest({}, { user: { id: 'spoofed' }, page: '/share/secret', extras: { chatId: 'chat-1' } }),
    });

    expect(response.status).toBe(400);
  });

  it('rejects free-form messages and exception details instead of logging them', async () => {
    const response = await clientTelemetryAction({
      env,
      request: telemetryRequest(
        {},
        {
          kind: 'exception',
          event: 'Failed to submit chat message',
          error: { message: 'Authorization: Basic dXNlcjpwYXNz; password: secret; person@example.test' },
        },
      ),
    });

    expect(response.status).toBe(400);
  });
});

function telemetryRequest(headers: Record<string, string> = {}, overrides: Record<string, unknown> = {}): Request {
  return new Request('https://ghostbuild.dev/api/client-telemetry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://ghostbuild.dev', ...headers },
    body: JSON.stringify({ kind: 'message', event: 'Builder client tool call failed', ...overrides }),
  });
}
