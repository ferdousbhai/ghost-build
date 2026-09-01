// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './data-api';
import { DataOperationError } from './client';
import { useAllSubchatsState, useQuery as useDataQuery } from './data-hooks';
import { useChatHistory } from './chat-history-db';
import { queryClient as collectionQueryClient } from '~/lib/stores/reactQueryClient';

const executeDataOperation = vi.hoisted(() => vi.fn());

vi.mock('./client', () => {
  class UserRuntimeRequestError extends Error {
    constructor(
      message: string,
      readonly status: number | undefined,
      readonly retryable: boolean,
    ) {
      super(message);
    }
  }

  return {
    UserRuntimeRequestError,
    DataOperationError: class DataOperationError extends UserRuntimeRequestError {},
    executeDataOperation,
  };
});

function useProjectHistoryError() {
  return useChatHistory('error-user').error;
}

function useSubchatHistoryError() {
  return useAllSubchatsState({ chatId: 'error-chat', sessionId: 'error-user' }).error;
}

async function waitForReactUpdate(assertion: () => void): Promise<void> {
  await vi.waitFor(async () => {
    await act(() => Promise.resolve());
    assertion();
  });
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  executeDataOperation.mockReset();
  collectionQueryClient.clear();
  document.body.replaceChildren();
});

describe('Query DB collection errors', () => {
  it.each([
    ['project history', useProjectHistoryError],
    ['subchat history', useSubchatHistoryError],
  ])('surfaces an initial %s failure after the source collection becomes ready', async (_name, useError) => {
    executeDataOperation.mockRejectedValue(new DataOperationError('cold load failed', 400, false));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    function Harness() {
      const error = useError();
      return createElement('span', null, error instanceof Error ? error.message : 'none');
    }

    await act(async () => root.render(createElement(Harness)));
    await waitForReactUpdate(() => expect(container.textContent).toBe('cold load failed'));
    await act(async () => root.unmount());
  });
});

describe('useQuery', () => {
  it('forwards the TanStack query cancellation signal', async () => {
    let operationSignal: AbortSignal | undefined;
    executeDataOperation.mockImplementation(
      (_path: unknown, _args: unknown, options: { signal?: AbortSignal } | undefined) => {
        operationSignal = options?.signal;
        return new Promise((_resolve, reject) => {
          operationSignal?.addEventListener('abort', () => reject(operationSignal?.reason), { once: true });
        });
      },
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    function Harness() {
      useDataQuery(api.messages.get, { id: 'chat-1', sessionId: 'user-1' });
      return null;
    }

    await act(async () => {
      root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(Harness)));
    });

    await waitForReactUpdate(() => expect(operationSignal).toBeInstanceOf(AbortSignal));
    await act(async () => root.unmount());
    expect(operationSignal?.aborted).toBe(true);
    queryClient.clear();
  });
});
