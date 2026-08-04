import { describe, expect, it, vi } from 'vitest';
import { computerRolloutUnavailableResponse, resolveComputerRollout } from './computer-rollout';

function database(row: unknown) {
  const first = vi.fn(async () => row);
  const bind = vi.fn(() => ({ first }));
  const prepare = vi.fn(() => ({ bind }));
  return { db: { prepare } as unknown as D1Database, prepare, bind };
}

describe('Cloudflare Computer rollout control', () => {
  it.each([
    [{ mode: 'all', cohort_basis_points: 10_000, cohort_salt: 'salt' }, true, 'all'],
    [{ mode: 'off', cohort_basis_points: 0, cohort_salt: 'salt' }, false, 'off'],
    [null, false, 'invalid'],
    [{ mode: 'cohort', cohort_basis_points: 10_001, cohort_salt: 'salt' }, false, 'invalid'],
  ] as const)('fails closed and honors explicit global modes: %o', async (row, enabled, mode) => {
    const { db, bind } = database(row);
    await expect(resolveComputerRollout(db, 'user-1')).resolves.toEqual({ enabled, mode });
    expect(bind).toHaveBeenCalledWith('cloudflare_computer');
  });

  it('assigns a user deterministically to a bounded cohort without exposing the bucket', async () => {
    const half = database({ mode: 'cohort', cohort_basis_points: 5_000, cohort_salt: 'launch-v1' });
    const first = await resolveComputerRollout(half.db, 'user-1');
    const second = await resolveComputerRollout(half.db, 'user-1');
    expect(second).toEqual(first);
    expect(first.mode).toBe('cohort');

    const all = database({ mode: 'cohort', cohort_basis_points: 10_000, cohort_salt: 'launch-v1' });
    const none = database({ mode: 'cohort', cohort_basis_points: 0, cohort_salt: 'launch-v1' });
    await expect(resolveComputerRollout(all.db, 'user-1')).resolves.toMatchObject({ enabled: true });
    await expect(resolveComputerRollout(none.db, 'user-1')).resolves.toMatchObject({ enabled: false });
  });

  it('uses a statistically representative 32-bit cohort sample', async () => {
    const tenPercent = database({ mode: 'cohort', cohort_basis_points: 1_000, cohort_salt: 'distribution-v1' });
    const decisions = await Promise.all(
      Array.from({ length: 2_000 }, (_, index) => resolveComputerRollout(tenPercent.db, `user-${index}`)),
    );
    const enabled = decisions.filter((decision) => decision.enabled).length;

    expect(enabled).toBeGreaterThanOrEqual(160);
    expect(enabled).toBeLessThanOrEqual(240);
  });

  it('fails closed when the rollout store is unavailable', async () => {
    const db = {
      prepare: vi.fn(() => {
        throw new Error('database unavailable');
      }),
    } as unknown as D1Database;

    await expect(resolveComputerRollout(db, 'user-1')).resolves.toEqual({ enabled: false, mode: 'invalid' });
  });

  it('returns a typed, non-cacheable retry response', async () => {
    const response = computerRolloutUnavailableResponse();
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('retry-after')).toBe('300');
    await expect(response.json()).resolves.toMatchObject({ code: 'computer_preview_unavailable' });
  });
});
