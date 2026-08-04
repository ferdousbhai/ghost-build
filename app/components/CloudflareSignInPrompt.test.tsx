// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudflareSignInPrompt } from './CloudflareSignInPrompt';

const auth = vi.hoisted(() => ({
  createCloudflareSetupCallbackURL: vi.fn(() => 'http://localhost/settings?continue=%2F#cloudflare'),
  signInWithCloudflare: vi.fn(),
}));

vi.mock('~/lib/auth-client', () => auth);

let root: Root | undefined;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  auth.createCloudflareSetupCallbackURL.mockClear();
  auth.signInWithCloudflare.mockReset();
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  document.body.replaceChildren();
});

describe('CloudflareSignInPrompt', () => {
  it('routes authentication through explicit runtime setup', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <CloudflareSignInPrompt title="Connect Cloudflare" description="Use the account that owns this project." />,
      ),
    );

    const connect = [...document.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Connect Cloudflare'),
    );
    await act(async () => connect?.click());

    expect(auth.createCloudflareSetupCallbackURL).toHaveBeenCalledOnce();
    expect(auth.signInWithCloudflare).toHaveBeenCalledWith('http://localhost/settings?continue=%2F#cloudflare');
  });
});
