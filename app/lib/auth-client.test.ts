// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createCloudflareSetupCallbackURL,
  resolveCloudflareSetupContinuation,
  signInWithCloudflare,
  signOutOfGhostbuild,
} from './auth-client';

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

describe('Cloudflare setup continuation', () => {
  test('routes OAuth through settings while preserving a same-origin builder destination', () => {
    expect(
      createCloudflareSetupCallbackURL(
        'https://ghostbuild.dev/chat/project?panel=code#preview',
        'https://ghostbuild.dev',
      ),
    ).toBe('https://ghostbuild.dev/settings?continue=%2Fchat%2Fproject%3Fpanel%3Dcode%23preview#cloudflare');
  });

  test('rejects external and protocol-relative continuations', () => {
    expect(createCloudflareSetupCallbackURL('https://attacker.example/path', 'https://ghostbuild.dev')).toBe(
      'https://ghostbuild.dev/settings?continue=%2F#cloudflare',
    );
    expect(resolveCloudflareSetupContinuation('?continue=%2F%2Fattacker.example')).toBe('/');
  });

  test('does not nest settings callbacks after an interrupted setup', () => {
    expect(
      createCloudflareSetupCallbackURL(
        'https://ghostbuild.dev/settings?continue=%2Fchat%2Fproject#cloudflare',
        'https://ghostbuild.dev',
      ),
    ).toBe('https://ghostbuild.dev/settings?continue=%2Fchat%2Fproject#cloudflare');
  });
});
