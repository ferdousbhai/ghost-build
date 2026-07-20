import { atom } from 'nanostores';
import { describe, expect, it, vi } from 'vitest';
import { waitForStoreCondition, waitForStoreValue } from './waitForStore';

describe('waitForStore', () => {
  it('resolves conditions that are already true', async () => {
    const store = atom(2);

    await expect(waitForStoreCondition(store, (value) => value > 1)).resolves.toBeUndefined();
  });

  it('waits for a selected value', async () => {
    const store = atom<number | null>(null);
    const promise = waitForStoreValue(store, (value) => value);

    store.set(3);

    await expect(promise).resolves.toBe(3);
  });

  it('rejects when the selector throws while listening', async () => {
    const store = atom('waiting');
    const promise = waitForStoreValue(store, (value) => {
      if (value === 'error') {
        throw new Error('selector failed');
      }
      return null;
    });

    store.set('error');

    await expect(promise).rejects.toThrow('selector failed');
  });

  it('unsubscribes when the wait is aborted', async () => {
    const unlisten = vi.fn();
    const listen = vi.fn(() => unlisten);
    const store = { get: () => 'waiting', listen };
    const controller = new AbortController();
    const promise = waitForStoreCondition(store, (value) => value === 'ready', { signal: controller.signal });

    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(listen).toHaveBeenCalledOnce();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it('rejects immediately for an already aborted signal without listening', async () => {
    const listen = vi.fn(() => vi.fn());
    const store = { get: () => 'waiting', listen };
    const controller = new AbortController();
    controller.abort();

    await expect(
      waitForStoreCondition(store, (value) => value === 'ready', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(listen).not.toHaveBeenCalled();
  });

  it('unsubscribes when a value becomes ready during listener registration', async () => {
    const unlisten = vi.fn();
    const store = {
      get: () => 'waiting',
      listen: (listener: (value: string) => void) => {
        listener('ready');
        return unlisten;
      },
    };

    await expect(waitForStoreValue(store, (value) => (value === 'ready' ? value : null))).resolves.toBe('ready');
    expect(unlisten).toHaveBeenCalledOnce();
  });
});
