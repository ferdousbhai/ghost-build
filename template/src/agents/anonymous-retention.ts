const EXPIRY_CALLBACK = "expireAnonymousSession";
const EXPIRY_RETRY = {
  maxAttempts: 5,
  baseDelayMs: 250,
  maxDelayMs: 5_000,
} as const;
const MAX_SCHEDULED_DATE_MS = 8_639_999_999_999_000;

type ExpiryPayload = { expiresAt: number };

type ScheduledExpiry = {
  callback: string;
  payload: unknown;
};

export type AnonymousAgentRetentionHost = {
  schedule(
    when: Date,
    callback: typeof EXPIRY_CALLBACK,
    payload: ExpiryPayload,
    options: {
      idempotent: true;
      retry: typeof EXPIRY_RETRY;
    },
  ): Promise<unknown>;
  listSchedules(): Promise<ScheduledExpiry[]>;
  destroy(): Promise<void>;
};

/**
 * Durably registers the authoritative D1 session expiry before an anonymous
 * request can use its Agent. Date schedules are rounded up because the Agents
 * scheduler persists timestamps at second precision.
 */
export async function refreshAnonymousAgentRetention(
  host: AnonymousAgentRetentionHost,
  expiresAt: number,
  now = Date.now(),
): Promise<boolean> {
  const validExpiry =
    Number.isSafeInteger(expiresAt) &&
    expiresAt > 0 &&
    expiresAt <= MAX_SCHEDULED_DATE_MS;
  const normalizedExpiry = validExpiry ? expiresAt : 0;
  const active = validExpiry && expiresAt > now;
  const scheduledAt = active ? Math.ceil(expiresAt / 1_000) * 1_000 : now;
  await host.schedule(
    new Date(scheduledAt),
    EXPIRY_CALLBACK,
    { expiresAt: normalizedExpiry },
    { idempotent: true, retry: EXPIRY_RETRY },
  );
  return active;
}

/**
 * Deletes every table and persisted message owned by the Agent unless a later
 * session expiry has already been registered. Multiple refresh schedules are
 * harmless: old callbacks finish without touching current state.
 */
export async function expireAnonymousAgent(
  host: AnonymousAgentRetentionHost,
  payload: ExpiryPayload,
): Promise<boolean> {
  const schedules = await host.listSchedules();
  const hasLaterExpiry = schedules.some(
    (schedule) =>
      schedule.callback === EXPIRY_CALLBACK &&
      isExpiryPayload(schedule.payload) &&
      schedule.payload.expiresAt > payload.expiresAt,
  );
  if (hasLaterExpiry) {
    return false;
  }
  await host.destroy();
  return true;
}

function isExpiryPayload(value: unknown): value is ExpiryPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    "expiresAt" in value &&
    Number.isSafeInteger(value.expiresAt)
  );
}
