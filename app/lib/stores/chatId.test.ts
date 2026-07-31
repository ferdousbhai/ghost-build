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

  it('builds a reload-safe mask for the resumable chat URL', async () => {
    const { chatUrlMask, setKnownInitialId } = await import('./chatId');

    setKnownInitialId('initial-chat-id');

    expect(chatUrlMask('initial-chat-id')).toEqual({
      to: '/chat/$id',
      params: { id: 'initial-chat-id' },
      unmaskOnReload: true,
    });
  });

  it('uses the real URL ID once it has been assigned', async () => {
    const { chatIdStore, setKnownInitialId, setKnownUrlId } = await import('./chatId');

    setKnownInitialId('initial-chat-id');
    setKnownUrlId('todo-app');

    expect(chatIdStore.get()).toBe('todo-app');
  });
});
