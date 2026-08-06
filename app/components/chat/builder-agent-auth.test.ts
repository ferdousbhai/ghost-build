import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getUserRuntimeSession } from '~/lib/cloudflare/runtime-session';
import { BUILDER_AGENT_QUERY_CACHE_TTL_MS, loadBuilderAgentCapability } from './builder-agent-auth';

vi.mock('~/lib/cloudflare/runtime-session', () => ({
  getUserRuntimeSession: vi.fn(),
}));

describe('BuilderAgent connection authentication', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('loads the current capability whenever the Agents SDK connects', async () => {
    vi.mocked(getUserRuntimeSession)
      .mockResolvedValueOnce({ endpoint: 'https://runtime.example', token: 'first', expiresAt: 1 })
      .mockResolvedValueOnce({ endpoint: 'https://runtime.example', token: 'second', expiresAt: 2 });

    await expect(loadBuilderAgentCapability()).resolves.toEqual({ capability: 'first' });
    await expect(loadBuilderAgentCapability()).resolves.toEqual({ capability: 'second' });
  });

  it('leaves capability refresh to genuine socket reconnects', () => {
    expect(BUILDER_AGENT_QUERY_CACHE_TTL_MS).toBe(0);
  });
});
