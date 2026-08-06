// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { disposeAccountLocalReplicas, useAccountLocalReplica } from './account-local-replica';

const openDatabase = vi.hoisted(() => vi.fn());

vi.mock('@tanstack/browser-db-sqlite-persistence', () => ({
  BrowserCollectionCoordinator: class {
    dispose() {
      return undefined;
    }
  },
  createBrowserWASQLitePersistence: ({ database }: { database: { id: string } }) => ({ id: database.id }),
  openBrowserWASQLiteOPFSDatabase: openDatabase,
  persistedCollectionOptions: vi.fn(),
}));

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('account local replica scope', () => {
  afterEach(async () => {
    await disposeAccountLocalReplicas();
    openDatabase.mockReset();
    document.body.replaceChildren();
  });

  it('never exposes the previous account replica while the next account opens', async () => {
    let resolveSecond: ((value: { id: string; close: () => Promise<void> }) => void) | undefined;
    openDatabase.mockResolvedValueOnce({ id: 'account-a', close: vi.fn() }).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSecond = resolve;
        }),
    );

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    function Harness({ sessionId }: { sessionId: string }) {
      const replica = useAccountLocalReplica(sessionId);
      const id = (replica?.persistence as { id?: string } | undefined)?.id;
      return <span>{replica === undefined ? 'loading' : (id ?? 'memory')}</span>;
    }

    await act(async () => root.render(<Harness sessionId="session-a" />));
    await vi.waitFor(() => expect(container.textContent).toBe('account-a'));

    await act(async () => root.render(<Harness sessionId="session-b" />));
    expect(container.textContent).toBe('loading');

    await vi.waitFor(() => expect(resolveSecond).toBeTypeOf('function'));
    await act(async () => resolveSecond?.({ id: 'account-b', close: vi.fn() }));
    await vi.waitFor(() => expect(container.textContent).toBe('account-b'));
    await act(async () => root.unmount());
  });
});
