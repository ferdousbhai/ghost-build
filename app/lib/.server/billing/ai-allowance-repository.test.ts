import { describe, expect, test, vi } from 'vitest';
import {
  AI_ALLOWANCE_RESERVATION_STALE_MS,
  releaseAiAllowance,
  releaseStaleAiAllowanceReservations,
  settleAiAllowance,
} from './ai-allowance-repository';

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

describe('AI allowance reservation finalization', () => {
  test('charges usage only while the reservation is still active', async () => {
    const database = finalizationDatabase();

    await settleAiAllowance(
      database.db,
      'reservation-1',
      25,
      { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3 },
      new Date('2026-07-13T12:00:00.000Z'),
    );

    const dailyUpdate = database.statements.find((statement) =>
      statement.query.includes('input_tokens = input_tokens'),
    );
    expect(dailyUpdate?.query).toContain("WHERE id = ? AND status = 'active'");
    expect(dailyUpdate?.values.at(-1)).toBe('reservation-1');
  });

  test('releases cost only while the reservation is still active', async () => {
    const database = finalizationDatabase();

    await releaseAiAllowance(database.db, 'reservation-1', new Date('2026-07-13T12:00:00.000Z'));

    const dailyUpdate = database.statements.find((statement) => statement.query.startsWith('UPDATE ai_daily_usage'));
    expect(dailyUpdate?.query).toContain("WHERE id = ? AND status = 'active'");
    expect(dailyUpdate?.values.at(-1)).toBe('reservation-1');
  });
});

function finalizationDatabase() {
  const statements: Array<{ query: string; values: unknown[] }> = [];
  const db = {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          const statement = {
            query,
            values,
            first: vi.fn(async () =>
              query.includes('FROM ai_usage_reservations')
                ? {
                    subject_key: 'guest:one',
                    usage_date: '2026-07-13',
                    status: 'active',
                    reserved_cost_nanodollars: 100,
                  }
                : query.includes('FROM ai_daily_usage')
                  ? {
                      charged_cost_nanodollars: 25,
                      reserved_cost_nanodollars: 0,
                      last_notified_threshold: 0,
                    }
                  : null,
            ),
            run: vi.fn(async () => ({ meta: { changes: 1 } })),
          };
          statements.push(statement);
          return statement;
        },
      };
    },
    batch: vi.fn(async () => []),
  } as unknown as D1Database;
  return { db, statements };
}
