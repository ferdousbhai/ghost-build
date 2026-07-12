import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Cloudflare client telemetry', () => {
  const sendBeacon = vi.fn();
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('navigator', { sendBeacon });
    vi.stubGlobal('window', { location: { href: 'https://ghostbuild.dev/chat/example' }, prompt: vi.fn() });
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

    await captureMessage('Preview failed', { level: 'warning' });

    expect(sendBeacon).toHaveBeenCalledWith('/api/client-telemetry', expect.any(Blob));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to a keepalive request when sendBeacon declines the event', async () => {
    sendBeacon.mockReturnValue(false);
    const { captureException } = await import('./telemetry.client');

    await captureException(new Error('Build failed'));

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/client-telemetry',
      expect.objectContaining({ method: 'POST', keepalive: true }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({ kind: 'exception', message: 'Build failed' });
  });

  it('includes current user and extra context', async () => {
    sendBeacon.mockReturnValue(false);
    const { captureMessage, setTelemetryExtra, setTelemetryUser } = await import('./telemetry.client');
    setTelemetryExtra('chatId', 'chat-1');
    setTelemetryUser({ id: 'user-1' });

    await captureMessage('Something happened');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({ extras: { chatId: 'chat-1' }, user: { id: 'user-1' } });
  });

  it('submits non-empty feedback', async () => {
    sendBeacon.mockReturnValue(true);
    vi.mocked(window.prompt).mockReturnValue('  Make previews faster  ');
    const { openFeedbackForm } = await import('./telemetry.client');

    await openFeedbackForm();

    expect(sendBeacon).toHaveBeenCalledOnce();
  });
});
