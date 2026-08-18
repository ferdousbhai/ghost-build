import { beforeEach, describe, expect, it, vi } from 'vitest';

const runUpstreamWatcher = vi.hoisted(() => vi.fn());
const runAppResourceReconciliation = vi.hoisted(() => vi.fn());

vi.mock('~/lib/.server/builder-skills/upstream-sync', () => ({ runUpstreamWatcher }));
vi.mock('~/lib/.server/cloudflare/app-resource-reconcile-sweep', () => ({ runAppResourceReconciliation }));

import { runDailyMaintenance } from './daily-maintenance';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

/** The claim table, as SQLite applies the conditional upsert this module depends on. */
class FakeDb {
  claims = new Map<string, number>();
  failClaims = false;

  prepare(_sql: string) {
    let values: unknown[] = [];
    const statement = {
      bind: (...bound: unknown[]) => {
        values = bound;
        return statement;
      },
      run: async () => {
        if (this.failClaims) {
          throw new Error('D1_ERROR: the claim table is unavailable.');
        }
        const [job, now, dueBefore] = values as [string, number, number];
        const last = this.claims.get(job);
        if (last !== undefined && last > dueBefore) {
          return { success: true, meta: { changes: 0 } };
        }
        this.claims.set(job, now);
        return { success: true, meta: { changes: 1 } };
      },
    };
    return statement as unknown as D1PreparedStatement;
  }
}

function env(db: FakeDb): Env {
  return { DB: db } as unknown as Env;
}

describe('daily maintenance scheduling', () => {
  beforeEach(() => {
    runUpstreamWatcher.mockReset().mockResolvedValue({ status: 'unchanged' });
    runAppResourceReconciliation.mockReset().mockResolvedValue({ users: 0 });
  });

  it('runs both jobs on the first tick that claims them', async () => {
    const db = new FakeDb();

    await runDailyMaintenance(env(db), NOW);

    expect(runUpstreamWatcher).toHaveBeenCalledOnce();
    expect(runAppResourceReconciliation).toHaveBeenCalledOnce();
    expect([...db.claims.keys()]).toEqual(['builder-skill-sync', 'app-resource-reconcile']);
  });

  it('skips the other ninety-five ticks of the day', async () => {
    const db = new FakeDb();

    await runDailyMaintenance(env(db), NOW);
    for (let tick = 1; tick <= 4; tick += 1) {
      await runDailyMaintenance(env(db), NOW + tick * 15 * 60 * 1000);
    }

    expect(runUpstreamWatcher).toHaveBeenCalledOnce();
    expect(runAppResourceReconciliation).toHaveBeenCalledOnce();
  });

  it('runs again a day later', async () => {
    const db = new FakeDb();

    await runDailyMaintenance(env(db), NOW);
    await runDailyMaintenance(env(db), NOW + DAY);

    expect(runUpstreamWatcher).toHaveBeenCalledTimes(2);
    expect(runAppResourceReconciliation).toHaveBeenCalledTimes(2);
  });

  it('delays a missed run instead of losing it', async () => {
    // A wall-clock window at a fixed hour would skip the day entirely; an elapsed interval only
    // ever moves the next run later, so an outage across the old slot costs no run at all.
    const db = new FakeDb();

    await runDailyMaintenance(env(db), NOW);
    await runDailyMaintenance(env(db), NOW + 3 * DAY);

    expect(runUpstreamWatcher).toHaveBeenCalledTimes(2);
  });

  it('claims before running, so a throwing job waits out its interval', async () => {
    const db = new FakeDb();
    runUpstreamWatcher.mockRejectedValueOnce(new Error('GitHub builder skill request failed (503).'));

    await runDailyMaintenance(env(db), NOW);
    await runDailyMaintenance(env(db), NOW + 15 * 60 * 1000);

    expect(runUpstreamWatcher).toHaveBeenCalledOnce();
    // Each job owns its own slot, so the failure never blocks the sweep beside it.
    expect(runAppResourceReconciliation).toHaveBeenCalledOnce();
  });

  it('never runs a job whose slot could not be claimed', async () => {
    const db = new FakeDb();
    db.failClaims = true;

    await runDailyMaintenance(env(db), NOW);

    expect(runUpstreamWatcher).not.toHaveBeenCalled();
    expect(runAppResourceReconciliation).not.toHaveBeenCalled();
  });
});
