import { describe, expect, it } from 'vitest';
import { createToolTimeAccounting } from './tool-time-accounting';

function clock(script: number[]) {
  let index = 0;
  return () => script[Math.min(index++, script.length - 1)]!;
}

describe('tool time accounting', () => {
  it('counts a concurrent batch once, not once per tool', () => {
    // The whole point of the split: three parallel reads that each take a second cost the turn
    // one second. Summing them would report tool time larger than the turn itself.
    const accounting = createToolTimeAccounting(clock([0, 0, 0, 1_000, 1_000, 1_000]));
    accounting.start('a', 'read');
    accounting.start('b', 'read');
    accounting.start('c', 'read');
    accounting.end('a');
    accounting.end('b');
    accounting.end('c');

    expect(accounting.wallClockMs()).toBe(1_000);
    expect(accounting.byName()).toEqual({ read: 3_000 });
  });

  it('excludes the gaps between tool batches, which is the model time', () => {
    const accounting = createToolTimeAccounting(clock([0, 100, 5_000, 5_400]));
    accounting.start('a', 'exec');
    accounting.end('a');
    accounting.start('b', 'write');
    accounting.end('b');

    expect(accounting.wallClockMs()).toBe(500);
    expect(accounting.byName()).toEqual({ exec: 100, write: 400 });
  });
});
