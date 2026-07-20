import { describe, expect, test, vi } from 'vitest';
import {
  expireAnonymousAgent,
  refreshAnonymousAgentRetention,
  type AnonymousAgentRetentionHost,
} from '../template/src/agents/anonymous-retention';

describe('generated anonymous Agent retention', () => {
  test('durably schedules active session expiry with second-safe rounding and idempotency', async () => {
    const host = retentionHost();

    await expect(refreshAnonymousAgentRetention(host, 10_001, 1_000)).resolves.toBe(true);

    expect(host.schedule).toHaveBeenCalledWith(
      new Date(11_000),
      'expireAnonymousSession',
      { expiresAt: 10_001 },
      {
        idempotent: true,
        retry: { maxAttempts: 5, baseDelayMs: 250, maxDelayMs: 5_000 },
      },
    );
  });

  test('arms immediate cleanup and rejects a session that expires during routing', async () => {
    const host = retentionHost();

    await expect(refreshAnonymousAgentRetention(host, 999, 1_000)).resolves.toBe(false);

    expect(host.schedule).toHaveBeenCalledWith(
      new Date(1_000),
      'expireAnonymousSession',
      { expiresAt: 999 },
      expect.objectContaining({ idempotent: true }),
    );
  });

  test('fails closed and arms cleanup when persisted session expiry is invalid', async () => {
    const host = retentionHost();

    await expect(refreshAnonymousAgentRetention(host, Number.NaN, 1_000)).resolves.toBe(false);

    expect(host.schedule).toHaveBeenCalledWith(
      new Date(1_000),
      'expireAnonymousSession',
      { expiresAt: 0 },
      expect.objectContaining({ idempotent: true }),
    );
  });

  test('keeps state for a refreshed session when an older expiry callback fires', async () => {
    const host = retentionHost([
      {
        callback: 'expireAnonymousSession',
        payload: { expiresAt: 20_000 },
      },
    ]);

    await expect(expireAnonymousAgent(host, { expiresAt: 10_000 })).resolves.toBe(false);
    expect(host.destroy).not.toHaveBeenCalled();
  });

  test('destroys all persisted Agent storage at the latest registered expiry', async () => {
    const host = retentionHost([
      {
        callback: 'expireAnonymousSession',
        payload: { expiresAt: 10_000 },
      },
    ]);

    await expect(expireAnonymousAgent(host, { expiresAt: 10_000 })).resolves.toBe(true);
    expect(host.destroy).toHaveBeenCalledOnce();
  });
});

function retentionHost(schedules: Array<{ callback: string; payload: unknown }> = []) {
  return {
    schedule: vi.fn(async () => ({})),
    listSchedules: vi.fn(async () => schedules),
    destroy: vi.fn(async () => undefined),
  } satisfies AnonymousAgentRetentionHost;
}
