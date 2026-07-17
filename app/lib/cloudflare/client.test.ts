import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeDataOperation } from './client';
import { api } from './data-api';

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
});
