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

  it('keeps diagnostics local instead of sending platform telemetry', async () => {
    const { captureMessage } = await import('./telemetry.client');

    await captureMessage('Preview base URL unexpectedly had a trailing slash', { level: 'warning' });

    expect(console.warn).toHaveBeenCalled();
    expect(sendBeacon).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
