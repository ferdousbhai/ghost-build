// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from 'vitest';
import { signInWithCloudflare, signOutOfGhostbuild } from './auth-client';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Cloudflare auth client failures', () => {
  test('surfaces a non-OK sign-in response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'Cloudflare authorization is unavailable.' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await expect(signInWithCloudflare()).rejects.toThrow('Cloudflare authorization is unavailable.');
  });

  test('does not treat a non-OK sign-out response as success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'The session could not be revoked.' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await expect(signOutOfGhostbuild()).rejects.toThrow('The session could not be revoked.');
  });
});
