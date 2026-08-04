// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from 'vitest';
import { createCloudflareReturnURL, signInWithCloudflare, signOutOfGhostbuild } from './auth-client';

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

describe('Cloudflare return URL', () => {
  test('returns OAuth directly to the same-origin builder destination', () => {
    expect(
      createCloudflareReturnURL('https://ghostbuild.dev/chat/project?panel=code#preview', 'https://ghostbuild.dev'),
    ).toBe('https://ghostbuild.dev/chat/project?panel=code#preview');
  });

  test('rejects external and protocol-relative continuations', () => {
    expect(createCloudflareReturnURL('https://attacker.example/path', 'https://ghostbuild.dev')).toBe(
      'https://ghostbuild.dev/',
    );
    expect(createCloudflareReturnURL('https://ghostbuild.dev//attacker.example', 'https://ghostbuild.dev')).toBe(
      'https://ghostbuild.dev/',
    );
  });

  test('resumes the original destination after a failed authorization', () => {
    expect(
      createCloudflareReturnURL(
        'https://ghostbuild.dev/settings?continue=%2Fchat%2Fproject&cloudflare_authorization=failed#cloudflare',
        'https://ghostbuild.dev',
      ),
    ).toBe('https://ghostbuild.dev/chat/project');
    expect(
      createCloudflareReturnURL(
        'https://ghostbuild.dev/settings?continue=%2F%5Cattacker.example&cloudflare_authorization=failed',
        'https://ghostbuild.dev',
      ),
    ).toBe('https://ghostbuild.dev/settings');
  });
});
