// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudflareSignInPrompt } from './CloudflareSignInPrompt';

const auth = vi.hoisted(() => ({ signInWithCloudflare: vi.fn() }));

vi.mock('~/lib/auth-client', () => auth);

let root: Root | undefined;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
  it('preserves the complete private-route URL through the authorization handoff', async () => {
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

    expect(auth.signInWithCloudflare).toHaveBeenCalledWith(window.location.href);
  });
});
