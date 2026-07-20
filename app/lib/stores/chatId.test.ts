/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('chat URL lifecycle', () => {
  beforeEach(() => {
    vi.resetModules();
    window.history.replaceState({}, '', '/');
  });

  it('does not navigate to an empty draft ID during initialization', async () => {
    const { setKnownInitialId } = await import('./chatId');

    setKnownInitialId('initial-chat-id');

    expect(window.location.pathname).toBe('/');
  });

  it('navigates to the resumable draft only after the builder request starts', async () => {
    const { navigateToChat, setKnownInitialId } = await import('./chatId');

    setKnownInitialId('initial-chat-id');
    navigateToChat('initial-chat-id');

    expect(window.location.pathname).toBe('/chat/initial-chat-id');
  });

  it('replaces the draft ID once a real URL ID has been assigned', async () => {
    const { navigateToChat, setKnownInitialId, setKnownUrlId } = await import('./chatId');

    setKnownInitialId('initial-chat-id');
    navigateToChat('initial-chat-id');
    setKnownUrlId('todo-app');

    expect(window.location.pathname).toBe('/chat/todo-app');
  });
});
