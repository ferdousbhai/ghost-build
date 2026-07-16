import { describe, expect, it, vi } from 'vitest';

const { resolveAgentRequestIdentity } = vi.hoisted(() => ({ resolveAgentRequestIdentity: vi.fn() }));

vi.mock('~/lib/.server/agent-request-identity', () => ({ resolveAgentRequestIdentity }));

import { aiAllowanceStatusAction } from './ai-allowance';

function envWithUsage(usage: Record<string, unknown> | null) {
  const prepare = vi.fn((query: string) => ({
    bind: vi.fn(() => ({
      query,
      first: vi.fn(async () => usage),
    })),
  }));
  return {
    DB: {
      prepare,
      batch: vi.fn(async () => []),
    },
  } as unknown as Env;
}

describe('aiAllowanceStatusAction', () => {
  it('requires a server-recognized session', async () => {
    resolveAgentRequestIdentity.mockResolvedValueOnce(null);
    const response = await aiAllowanceStatusAction({
      request: new Request('https://ghostbuild.dev/api/ai/allowance'),
      env: envWithUsage(null),
    });
    expect(response.status).toBe(401);
  });

  it('reports the reached reminder threshold and daily cap', async () => {
    resolveAgentRequestIdentity.mockResolvedValueOnce({ billingSubjectKey: 'guest:one', ownerId: 'guest-one' });
    const response = await aiAllowanceStatusAction({
      request: new Request('https://ghostbuild.dev/api/ai/allowance'),
      env: envWithUsage({
        charged_cost_nanodollars: 910_000_000,
        reserved_cost_nanodollars: 0,
        last_notified_threshold: 90,
      }),
    });
    expect(await response.json()).toMatchObject({
      dailyLimitUsd: 1,
      usedPercent: 91,
      exhausted: false,
      reminder: 90,
    });
  });
});
