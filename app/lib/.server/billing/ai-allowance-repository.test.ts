import { describe, expect, test, vi } from 'vitest';
import { AI_ALLOWANCE_RESERVATION_STALE_MS, releaseStaleAiAllowanceReservations } from './ai-allowance-repository';

describe('AI allowance reservation recovery', () => {
  test('atomically releases stale reservations and their reserved daily cost', async () => {
    const statements: Array<{ query: string; values: unknown[] }> = [];
    const batch = vi.fn().mockResolvedValue([]);
    const db = {
      prepare(query: string) {
        return {
          bind(...values: unknown[]) {
            const statement = { query, values };
            statements.push(statement);
            return statement;
          },
        };
      },
      batch,
    } as unknown as D1Database;
    const now = new Date('2026-07-13T12:00:00.000Z');

    await releaseStaleAiAllowanceReservations(db, 'guest:one', '2026-07-13', now);

    expect(batch).toHaveBeenCalledOnce();
    expect(batch.mock.calls[0]?.[0]).toEqual(statements);
    expect(statements).toHaveLength(2);
    expect(statements[0]?.query).toContain('SELECT SUM(reserved_cost_nanodollars)');
    expect(statements[1]?.query).toContain("SET status = 'released'");
    const staleBefore = now.getTime() - AI_ALLOWANCE_RESERVATION_STALE_MS;
    expect(statements[0]?.values).toEqual([
      'guest:one',
      '2026-07-13',
      staleBefore,
      now.getTime(),
      'guest:one',
      '2026-07-13',
    ]);
    expect(statements[1]?.values).toEqual([now.getTime(), 'guest:one', '2026-07-13', staleBefore]);
  });
});
