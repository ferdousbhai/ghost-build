import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeDataOperation } from './client';
import { api } from './data-api';

vi.mock('./runtime-session', () => ({
  fetchUserRuntime: (path: string, init?: RequestInit) => fetch(path, init),
}));

describe('executeDataOperation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('returns a successful operation result', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ result: { created: true } }));

    await expect(
      executeDataOperation(api.messages.initializeChat, { id: 'chat-1', sessionId: 'session-1' }),
    ).resolves.toEqual({ created: true });
  });

  it('aborts a data request instead of waiting forever', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });
    const request = executeDataOperation(api.messages.initializeChat, {
      id: 'chat-1',
      sessionId: 'session-1',
    });
    const rejection = expect(request).rejects.toThrow('Ghostbuild timed out while running messages.initializeChat');

    await vi.advanceTimersByTimeAsync(15_000);

    await rejection;
  });

  it('propagates caller cancellation to the active fetch', async () => {
    const caller = new AbortController();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    });

    const request = executeDataOperation(
      api.messages.initializeChat,
      { id: 'chat-1', sessionId: 'session-1' },
      { signal: caller.signal },
    );
    caller.abort(new DOMException('Query cancelled', 'AbortError'));

    await expect(request).rejects.toMatchObject({ name: 'AbortError', message: 'Query cancelled' });
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('rejects a successful response without a result field', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ unexpected: true }));

    await expect(
      executeDataOperation(api.messages.initializeChat, { id: 'chat-1', sessionId: 'session-1' }),
    ).rejects.toThrow('Data operation returned a malformed response: messages.initializeChat');
  });

  it('preserves HTTP status and retryability for query policy decisions', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ error: 'Invalid request' }, { status: 400 }));

    await expect(
      executeDataOperation(api.messages.initializeChat, { id: 'chat-1', sessionId: 'session-1' }),
    ).rejects.toMatchObject({ name: 'DataOperationError', status: 400, retryable: false });

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ error: 'Try later' }, { status: 503 }));
    await expect(
      executeDataOperation(api.messages.initializeChat, { id: 'chat-1', sessionId: 'session-1' }),
    ).rejects.toMatchObject({ name: 'DataOperationError', status: 503, retryable: true });
  });
});
