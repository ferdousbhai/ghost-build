import { atom } from 'nanostores';
import { describe, expect, it } from 'vitest';
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
});
