// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudflareSignInPrompt } from './CloudflareSignInPrompt';

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    Link: ({ children, to, ...props }: { children: React.ReactNode; to: string }) => (
      <a {...props} href={to}>
        {children}
      </a>
    ),
  };
});

const auth = vi.hoisted(() => ({
  createCloudflareReturnURL: vi.fn(() => 'http://localhost/'),
  signInWithCloudflare: vi.fn(),
}));

vi.mock('~/lib/auth-client', () => auth);

let root: Root | undefined;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  auth.createCloudflareReturnURL.mockClear();
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
  it('returns authentication directly to the requested page', async () => {
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

    expect(auth.createCloudflareReturnURL).toHaveBeenCalledOnce();
    expect(auth.signInWithCloudflare).toHaveBeenCalledWith('http://localhost/');
  });
});
