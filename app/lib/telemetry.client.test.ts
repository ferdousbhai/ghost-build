import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Cloudflare client telemetry', () => {
  const sendBeacon = vi.fn();
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('navigator', { sendBeacon });
    vi.stubGlobal('window', {
      location: { href: 'https://ghostbuild.dev/share/secret?token=credential' },
      prompt: vi.fn(),
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses sendBeacon for fire-and-forget events', async () => {
    sendBeacon.mockReturnValue(true);
    const { captureMessage } = await import('./telemetry.client');

    await captureMessage('Preview base URL unexpectedly had a trailing slash', { level: 'warning' });

    expect(sendBeacon).toHaveBeenCalledWith('/api/client-telemetry', expect.any(Blob));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to a keepalive request when sendBeacon declines the event', async () => {
    sendBeacon.mockReturnValue(false);
    const { captureException } = await import('./telemetry.client');

    await captureException('Failed to process chat request', new Error('Build failed'));

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/client-telemetry',
      expect.objectContaining({ method: 'POST', keepalive: true }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toEqual({ kind: 'exception', event: 'Failed to process chat request' });
  });

  it('omits exception details, identity, and route secrets', async () => {
    sendBeacon.mockReturnValue(false);
    const { captureException } = await import('./telemetry.client');

    await captureException('Failed to submit chat message', new Error('secret for person@example.test in chat-1'), {
      level: 'error',
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toEqual({
      kind: 'exception',
      event: 'Failed to submit chat message',
      context: { level: 'error' },
    });
  });
});
