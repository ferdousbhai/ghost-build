import { describe, expect, test, vi } from 'vitest';
import { openPreviewQuickTunnel, openReadyPreviewQuickTunnel, waitForPreviewQuickTunnel } from './preview-tunnel';

describe('openPreviewQuickTunnel', () => {
  test('opens a zero-configuration quick tunnel without named-tunnel options', async () => {
    const get = vi.fn(async (_port: number) => ({ url: 'https://random-words.trycloudflare.com' }));

    await expect(openPreviewQuickTunnel({ get }, 4173)).resolves.toEqual({
      url: 'https://random-words.trycloudflare.com',
    });

    expect(get).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledWith(4173);
    expect(get.mock.calls[0]).toHaveLength(1);
  });

  test('waits for a quick tunnel to become publicly reachable', async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const wait = vi.fn(async () => undefined);

    await expect(
      waitForPreviewQuickTunnel('https://random-words.trycloudflare.com', { fetcher, wait }),
    ).resolves.toBeUndefined();

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledOnce();
  });

  test('replaces a quick tunnel that never becomes reachable', async () => {
    let now = 0;
    const get = vi
      .fn()
      .mockResolvedValueOnce({ url: 'https://unreachable.trycloudflare.com' })
      .mockResolvedValueOnce({ url: 'https://reachable.trycloudflare.com' });
    const destroy = vi.fn(async () => undefined);
    const fetcher = vi.fn(async (url: string) => {
      if (new URL(url).hostname === 'reachable.trycloudflare.com') {
        return new Response(null, { status: 200 });
      }
      throw new TypeError('fetch failed');
    });
    const wait = vi.fn(async (delayMs: number) => {
      now += delayMs;
    });

    await expect(
      openReadyPreviewQuickTunnel({ get, destroy }, 4173, { fetcher, now: () => now, timeoutMs: 1_000, wait }),
    ).resolves.toEqual({ url: 'https://reachable.trycloudflare.com' });

    expect(destroy).toHaveBeenCalledWith(4173);
    expect(get).toHaveBeenCalledTimes(2);
  });
});
