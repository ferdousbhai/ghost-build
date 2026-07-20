import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSampler } from './sampler';

describe('createSampler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('executes the first call immediately and the latest trailing call', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const callback = vi.fn();
    const sampled = createSampler(callback, 50);

    sampled('first');
    sampled('dropped');
    sampled('latest');
    vi.advanceTimersByTime(50);

    expect(callback.mock.calls).toEqual([['first'], ['latest']]);
  });

  it('cancels a pending trailing call and can be reused', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const callback = vi.fn();
    const sampled = createSampler(callback, 50);

    sampled('first');
    sampled('pending');
    sampled.cancel();
    vi.advanceTimersByTime(50);
    sampled('after cancel');

    expect(callback.mock.calls).toEqual([['first'], ['after cancel']]);
  });
});
