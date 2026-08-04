import { afterEach, describe, expect, it, vi } from 'vitest';
import { debounce } from './debounce';

describe('debounce', () => {
  afterEach(() => vi.useRealTimers());

  it('flushes the latest pending call exactly once', async () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const debounced = debounce(callback, 150);

    debounced('old');
    debounced('latest');
    expect(debounced.pending()).toBe(true);

    debounced.flush();
    debounced.flush();
    await vi.advanceTimersByTimeAsync(150);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith('latest');
    expect(debounced.pending()).toBe(false);
  });

  it('cancels without invoking a pending call', async () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const debounced = debounce(callback, 150);

    debounced('discarded');
    debounced.cancel();
    debounced.flush();
    await vi.advanceTimersByTimeAsync(150);

    expect(callback).not.toHaveBeenCalled();
    expect(debounced.pending()).toBe(false);
  });
});
