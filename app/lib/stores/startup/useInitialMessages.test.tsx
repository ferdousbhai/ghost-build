// @vitest-environment jsdom

import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionIdStore } from '~/lib/stores/sessionId';
import { subchatIndexStore } from '~/lib/stores/subchats';
import { useInitialMessages } from './useInitialMessages';
import { description } from '~/lib/stores/description';

const executeDataOperationMock = vi.hoisted(() => vi.fn());

vi.mock('~/lib/cloudflare/client', () => ({
  executeDataOperation: executeDataOperationMock,
}));
vi.mock('~/lib/compression', () => ({
  decompressWithLz4: (value: Uint8Array) => value,
}));

describe('useInitialMessages', () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    subchatIndexStore.set(0);
    sessionIdStore.set(undefined);
    executeDataOperationMock.mockReset();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    sessionIdStore.set(undefined);
    subchatIndexStore.set(undefined);
    description.set(undefined);
    document.body.replaceChildren();
  });

  it('reloads a project when authentication replaces a temporary guest session', async () => {
    executeDataOperationMock.mockImplementation(async (_operation: unknown, args: { sessionId: string }) => {
      if (args.sessionId === 'guest-session') {
        return null;
      }
      return {
        initialId: 'project-id',
        urlId: undefined,
        description: 'Project',
        subchatIndex: 0,
      };
    });

    const seen: Array<'loading' | 'missing' | 'ready'> = [];
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    function Harness() {
      const messages = useInitialMessages('project-id');
      const state = messages === undefined ? 'loading' : messages === null ? 'missing' : 'ready';
      useEffect(() => {
        seen.push(state);
      }, [state]);
      return <span>{state}</span>;
    }

    await act(async () => {
      root.render(<Harness />);
      sessionIdStore.set('guest-session');
    });
    expect(container.textContent).toBe('missing');

    await act(async () => {
      sessionIdStore.set('signed-in-user');
    });
    expect(container.textContent).toBe('ready');
    expect(seen).toContain('missing');
    expect(seen.at(-1)).toBe('ready');
    expect(executeDataOperationMock).toHaveBeenCalledTimes(2);
    expect(description.get()).toBe('Project');

    await act(async () => root.unmount());
  });
});
