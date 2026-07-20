import { describe, expect, it, vi } from 'vitest';
import { bufferWatchEvents } from './buffer';

describe('bufferWatchEvents', () => {
  it('flushes pending events immediately', async () => {
    vi.useFakeTimers();
    const batches: number[][] = [];
    const buffered = bufferWatchEvents<[number]>(100, (events) => {
      batches.push(events.map(([value]) => value));
    });

    buffered(1);
    buffered(2);
    await buffered.flush();

    expect(batches).toEqual([[1, 2]]);
    await vi.runAllTimersAsync();
    expect(batches).toEqual([[1, 2]]);
    vi.useRealTimers();
  });

  it('processes async batches in order', async () => {
    const events: number[] = [];
    const buffered = bufferWatchEvents<[number]>(100, async (batch) => {
      await Promise.resolve();
      events.push(...batch.map(([value]) => value));
    });

    buffered(1);
    const firstFlush = buffered.flush();
    buffered(2);
    await Promise.all([firstFlush, buffered.flush()]);

    expect(events).toEqual([1, 2]);
  });
});
