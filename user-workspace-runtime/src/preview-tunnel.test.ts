import { describe, expect, test, vi } from 'vitest';
import { openPreviewQuickTunnel } from './preview-tunnel';

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
});
