import { describe, expect, it } from 'vitest';

/**
 * Models `@cloudflare/containers` `Container.schedule`: it mints a fresh row id per call and
 * `INSERT OR REPLACE`s on that id, so no call ever replaces an earlier row. Its published
 * signature takes (when, callback, payload) only — a fourth options argument is discarded.
 */
class FakeContainer {
  rows: Array<{ id: string; callback: string; payload: unknown; time: number }> = [];
  #next = 0;

  async schedule(when: number, callback: string, payload?: unknown): Promise<void> {
    const id = `row-${this.#next++}`;
    this.rows = [...this.rows.filter((row) => row.id !== id), { id, callback, payload, time: when }];
  }

  deleteSchedules(callback: string): void {
    this.rows = this.rows.filter((row) => row.callback !== callback);
  }
}

/** The previous implementation: pass an options bag the base class silently drops. */
async function scheduleOnceOld(container: FakeContainer, when: number, callback: string, payload: unknown) {
  const schedule = container.schedule as unknown as (
    w: number,
    c: string,
    p: unknown,
    o: { idempotent: true },
  ) => Promise<void>;
  await schedule.call(container, when, callback, payload, { idempotent: true });
}

/** The fixed implementation. */
async function scheduleOnceNew(container: FakeContainer, when: number, callback: string, payload: unknown) {
  container.deleteSchedules(callback);
  await container.schedule(when, callback, payload);
}

describe('scheduleOnce dedupe', () => {
  it('reproduces the stacking bug in the old implementation', async () => {
    const container = new FakeContainer();
    for (let attempt = 1; attempt <= 5; attempt++) {
      await scheduleOnceOld(container, attempt * 10, 'retryPendingComputerSync', {
        backend: 'container-shell',
        attempt,
        notBefore: 1_000 * attempt,
      });
    }
    expect(container.rows).toHaveLength(5);
  });

  it('keeps exactly one pending row per callback', async () => {
    const container = new FakeContainer();
    for (let attempt = 1; attempt <= 5; attempt++) {
      await scheduleOnceNew(container, attempt * 10, 'retryPendingComputerSync', {
        backend: 'container-shell',
        attempt,
        notBefore: 1_000 * attempt,
      });
    }
    expect(container.rows).toHaveLength(1);
    expect(container.rows[0]).toMatchObject({
      callback: 'retryPendingComputerSync',
      payload: { attempt: 5 },
    });
  });

  it('does not let one callback evict the other', async () => {
    const container = new FakeContainer();
    await scheduleOnceNew(container, 10, 'retryPendingComputerSync', { notBefore: 1 });
    await scheduleOnceNew(container, 60, 'reconcilePendingCommands', { notBefore: 2 });
    await scheduleOnceNew(container, 20, 'retryPendingComputerSync', { notBefore: 3 });

    expect(container.rows).toHaveLength(2);
    expect(container.rows.map((row) => row.callback).sort()).toEqual([
      'reconcilePendingCommands',
      'retryPendingComputerSync',
    ]);
  });
});
