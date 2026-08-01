// @vitest-environment jsdom

import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionIdStore } from '~/lib/stores/sessionId';
import { subchatIndexStore } from '~/lib/stores/subchats';
import { useInitialMessages } from './useInitialMessages';
import { description } from '~/lib/stores/description';
import { queryClient } from '~/lib/stores/reactQueryClient';

const executeDataOperationMock = vi.hoisted(() => vi.fn());

vi.mock('~/lib/cloudflare/client', () => ({
  executeDataOperation: executeDataOperationMock,
}));
vi.mock('~/lib/cloudflare/runtime-session', () => ({
  fetchUserRuntime: (path: string, init?: RequestInit) => fetch(path, init),
}));
vi.mock('~/lib/cloudflare/account-local-replica', () => ({
  ACCOUNT_LOCAL_REPLICA_SCHEMA_VERSION: 1,
  useAccountLocalReplica: () => null,
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
      if (args.sessionId === 'stale-session') {
        return null;
      }
      return {
        initialId: 'project-id',
        urlId: undefined,
        description: 'Project',
        subchatIndex: 0,
        transcript: { agentName: 'project-id', generation: 0, subchatIndex: 0 },
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
      sessionIdStore.set('stale-session');
    });
    await act(async () => {
      await vi.waitFor(() => expect(container.textContent).toBe('missing'));
    });

    await act(async () => {
      sessionIdStore.set('signed-in-user');
    });
    await act(async () => {
      await vi.waitFor(() => expect(container.textContent).toBe('ready'));
    });
    expect(seen).toContain('missing');
    expect(seen.at(-1)).toBe('ready');
    expect(executeDataOperationMock).toHaveBeenCalledTimes(2);
    expect(description.get()).toBe('Project');

    await act(async () => root.unmount());
  });

  it('hides messages from the prior subchat immediately after navigation', async () => {
    let finishSubchatLoad: (() => void) | undefined;
    const subchatLoad = new Promise<void>((resolve) => {
      finishSubchatLoad = resolve;
    });
    executeDataOperationMock.mockImplementation(async (_operation: unknown, args: { subchatIndex?: number }) => {
      if (args.subchatIndex === 1) {
        await subchatLoad;
      }
      return {
        initialId: 'project-id',
        urlId: undefined,
        description: 'Project',
        subchatIndex: args.subchatIndex ?? 0,
        transcript: {
          agentName: args.subchatIndex === 1 ? 'project-id--transcript-1-0' : 'project-id',
          generation: 0,
          subchatIndex: args.subchatIndex ?? 0,
        },
      };
    });

    const states: string[] = [];
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    function Harness() {
      const messages = useInitialMessages('project-id');
      const state =
        messages === undefined ? 'loading' : messages === null ? 'missing' : `ready-${messages.loadedSubchatIndex}`;
      useEffect(() => {
        states.push(state);
      }, [state]);
      return <span>{state}</span>;
    }

    await act(async () => {
      root.render(<Harness />);
      sessionIdStore.set('signed-in-subchat-user');
    });
    await act(async () => {
      await vi.waitFor(() => expect(container.textContent).toBe('ready-0'));
    });

    await act(() => {
      subchatIndexStore.set(1);
    });
    expect(container.textContent).toBe('loading');

    await act(async () => {
      finishSubchatLoad?.();
    });
    await act(async () => {
      await vi.waitFor(() => expect(container.textContent).toBe('ready-1'));
    });
    expect(states).toContain('loading');

    await act(async () => root.unmount());
  });

  it('adopts a newer latest subchat discovered during server revalidation', async () => {
    let latestSubchatIndex = 0;
    executeDataOperationMock.mockImplementation(async () => ({
      initialId: 'project-id',
      urlId: undefined,
      description: 'Project',
      subchatIndex: latestSubchatIndex,
      transcript: {
        agentName: `project-id--transcript-${latestSubchatIndex}-0`,
        generation: 0,
        subchatIndex: latestSubchatIndex,
      },
    }));

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    function Harness() {
      const messages = useInitialMessages('project-id');
      return <span>{messages ? `ready-${messages.loadedSubchatIndex}` : 'loading'}</span>;
    }

    await act(async () => {
      root.render(<Harness />);
      sessionIdStore.set('signed-in-revalidation-user');
    });
    await act(async () => {
      await vi.waitFor(() => expect(container.textContent).toBe('ready-0'));
    });

    latestSubchatIndex = 1;
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: ['ghostbuild-local', 'transcripts', 'signed-in-revalidation-user'],
      });
      await vi.waitFor(() => expect(container.textContent).toBe('ready-1'));
    });

    await act(async () => root.unmount());
  });
});
