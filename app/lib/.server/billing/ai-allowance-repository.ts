import {
  GHOSTBUILD_DAILY_AI_ALLOWANCE_NANODOLLARS,
  type AiAllowanceReminder,
  aiAllowanceStatus,
  nextAiAllowanceReminder,
} from './ai-allowance-policy';

export const AI_ALLOWANCE_RESERVATION_STALE_MS = 30 * 60 * 1000;

export class AiAllowanceExceededError extends Error {
  constructor() {
    super("Today's free Ghostbuild AI allowance has been used. Connect Cloudflare to continue.");
    this.name = 'AiAllowanceExceededError';
  }
}

type AiAllowanceReservation = {
  id: string;
  subjectKey: string;
  usageDate: string;
  reservedCostNanodollars: number;
};

type SettledAiAllowance = {
  reminder: AiAllowanceReminder;
  usedPercent: number;
  exhausted: boolean;
};

type TokenUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

type ReservationRow = {
  subject_key: string;
  usage_date: string;
  status: 'active' | 'settled' | 'released';
  reserved_cost_nanodollars: number;
};

type DailyUsageRow = {
  charged_cost_nanodollars: number;
  reserved_cost_nanodollars: number;
  last_notified_threshold: AiAllowanceReminder;
};

export async function reserveAiAllowance(
  db: D1Database,
  subjectKey: string,
  reservedCostNanodollars: number,
  now = new Date(),
): Promise<AiAllowanceReservation> {
  if (!Number.isSafeInteger(reservedCostNanodollars) || reservedCostNanodollars <= 0) {
    throw new Error('reservedCostNanodollars must be a positive safe integer.');
  }
  const usageDate = utcUsageDate(now);
  const updatedAt = now.getTime();
  await releaseStaleAiAllowanceReservations(db, subjectKey, usageDate, now);
  await db
    .prepare(
      `INSERT INTO ai_daily_usage (subject_key, usage_date, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(subject_key, usage_date) DO NOTHING`,
    )
    .bind(subjectKey, usageDate, updatedAt)
    .run();

  const reserved = await db
    .prepare(
      `UPDATE ai_daily_usage
       SET reserved_cost_nanodollars = reserved_cost_nanodollars + ?, updated_at = ?
       WHERE subject_key = ? AND usage_date = ?
         AND charged_cost_nanodollars + reserved_cost_nanodollars + ? <= ?`,
    )
    .bind(
      reservedCostNanodollars,
      updatedAt,
      subjectKey,
      usageDate,
      reservedCostNanodollars,
      GHOSTBUILD_DAILY_AI_ALLOWANCE_NANODOLLARS,
    )
    .run();
  if (reserved.meta.changes !== 1) {
    throw new AiAllowanceExceededError();
  }

  const reservation: AiAllowanceReservation = {
    id: crypto.randomUUID(),
    subjectKey,
    usageDate,
    reservedCostNanodollars,
  };
  try {
    await db
      .prepare(
        `INSERT INTO ai_usage_reservations
          (id, subject_key, usage_date, status, reserved_cost_nanodollars, created_at)
         VALUES (?, ?, ?, 'active', ?, ?)`,
      )
      .bind(reservation.id, subjectKey, usageDate, reservedCostNanodollars, updatedAt)
      .run();
  } catch (error) {
    await removeReservedCost(db, reservation, updatedAt);
    throw error;
  }
  return reservation;
}

/**
 * Releases reservations left behind by an interrupted Worker or stream. The
 * two statements run in one D1 batch so a concurrent settlement cannot make
 * the daily reserved total and reservation rows disagree.
 */
export async function releaseStaleAiAllowanceReservations(
  db: D1Database,
  subjectKey: string,
  usageDate = utcUsageDate(new Date()),
  now = new Date(),
): Promise<void> {
  const releasedAt = now.getTime();
  const staleBefore = releasedAt - AI_ALLOWANCE_RESERVATION_STALE_MS;
  await db.batch([
    db
      .prepare(
        `UPDATE ai_daily_usage
         SET reserved_cost_nanodollars = MAX(
               0,
               reserved_cost_nanodollars - COALESCE(
                 (SELECT SUM(reserved_cost_nanodollars)
                  FROM ai_usage_reservations
                  WHERE subject_key = ? AND usage_date = ? AND status = 'active' AND created_at <= ?),
                 0
               )
             ),
             updated_at = ?
         WHERE subject_key = ? AND usage_date = ?`,
      )
      .bind(subjectKey, usageDate, staleBefore, releasedAt, subjectKey, usageDate),
    db
      .prepare(
        `UPDATE ai_usage_reservations
         SET status = 'released', settled_at = ?
         WHERE subject_key = ? AND usage_date = ? AND status = 'active' AND created_at <= ?`,
      )
      .bind(releasedAt, subjectKey, usageDate, staleBefore),
  ]);
}

export async function settleAiAllowance(
  db: D1Database,
  reservationId: string,
  actualCostNanodollars: number,
  usage: TokenUsage,
  now = new Date(),
): Promise<SettledAiAllowance | null> {
  const reservation = await findActiveReservation(db, reservationId);
  if (!reservation) {
    return null;
  }
  validateSettlement(actualCostNanodollars, usage);
  const settledAt = now.getTime();
  await db.batch([
    db
      .prepare(
        `UPDATE ai_daily_usage
         SET reserved_cost_nanodollars = MAX(0, reserved_cost_nanodollars - ?),
             charged_cost_nanodollars = charged_cost_nanodollars + ?,
             input_tokens = input_tokens + ?,
             cached_input_tokens = cached_input_tokens + ?,
             output_tokens = output_tokens + ?,
             updated_at = ?
         WHERE subject_key = ? AND usage_date = ?`,
      )
      .bind(
        reservation.reserved_cost_nanodollars,
        actualCostNanodollars,
        usage.inputTokens,
        usage.cachedInputTokens,
        usage.outputTokens,
        settledAt,
        reservation.subject_key,
        reservation.usage_date,
      ),
    db
      .prepare(
        `UPDATE ai_usage_reservations
         SET status = 'settled', actual_cost_nanodollars = ?, settled_at = ?
         WHERE id = ? AND status = 'active'`,
      )
      .bind(actualCostNanodollars, settledAt, reservationId),
  ]);

  const daily = await getDailyUsage(db, reservation.subject_key, reservation.usage_date);
  const reminder = nextAiAllowanceReminder(daily.charged_cost_nanodollars, daily.last_notified_threshold);
  if (reminder !== 0) {
    await db
      .prepare(
        `UPDATE ai_daily_usage SET last_notified_threshold = ?, updated_at = ?
         WHERE subject_key = ? AND usage_date = ? AND last_notified_threshold < ?`,
      )
      .bind(reminder, settledAt, reservation.subject_key, reservation.usage_date, reminder)
      .run();
  }
  const status = aiAllowanceStatus(daily.charged_cost_nanodollars, daily.reserved_cost_nanodollars);
  return { reminder, usedPercent: status.usedPercent, exhausted: status.exhausted };
}

export async function releaseAiAllowance(db: D1Database, reservationId: string, now = new Date()): Promise<void> {
  const reservation = await findActiveReservation(db, reservationId);
  if (!reservation) {
    return;
  }
  const releasedAt = now.getTime();
  await db.batch([
    removeReservedCostStatement(db, reservation, releasedAt),
    db
      .prepare(
        `UPDATE ai_usage_reservations SET status = 'released', settled_at = ?
         WHERE id = ? AND status = 'active'`,
      )
      .bind(releasedAt, reservationId),
  ]);
}

function findActiveReservation(db: D1Database, id: string): Promise<ReservationRow | null> {
  return db
    .prepare(
      `SELECT subject_key, usage_date, status, reserved_cost_nanodollars
       FROM ai_usage_reservations WHERE id = ? AND status = 'active'`,
    )
    .bind(id)
    .first<ReservationRow>();
}

async function getDailyUsage(db: D1Database, subjectKey: string, usageDate: string): Promise<DailyUsageRow> {
  const row = await db
    .prepare(
      `SELECT charged_cost_nanodollars, reserved_cost_nanodollars, last_notified_threshold
       FROM ai_daily_usage WHERE subject_key = ? AND usage_date = ?`,
    )
    .bind(subjectKey, usageDate)
    .first<DailyUsageRow>();
  if (!row) {
    throw new Error('AI daily usage row disappeared while settling a reservation.');
  }
  return row;
}

function removeReservedCost(db: D1Database, reservation: AiAllowanceReservation, updatedAt: number): Promise<D1Result> {
  return removeReservedCostStatement(
    db,
    {
      subject_key: reservation.subjectKey,
      usage_date: reservation.usageDate,
      status: 'active',
      reserved_cost_nanodollars: reservation.reservedCostNanodollars,
    },
    updatedAt,
  ).run();
}

function removeReservedCostStatement(db: D1Database, reservation: ReservationRow, updatedAt: number) {
  return db
    .prepare(
      `UPDATE ai_daily_usage
       SET reserved_cost_nanodollars = MAX(0, reserved_cost_nanodollars - ?), updated_at = ?
       WHERE subject_key = ? AND usage_date = ?`,
    )
    .bind(reservation.reserved_cost_nanodollars, updatedAt, reservation.subject_key, reservation.usage_date);
}

function validateSettlement(actualCostNanodollars: number, usage: TokenUsage): void {
  for (const [name, value] of Object.entries({ actualCostNanodollars, ...usage })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${name} must be a nonnegative safe integer.`);
    }
  }
}

export function utcUsageDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}
