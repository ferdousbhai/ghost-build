import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as AiAllowanceRepository from '~/lib/.server/billing/ai-allowance-repository';

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  resolveIdentity: vi.fn(),
  getCredentials: vi.fn(),
  getProvider: vi.fn(() => ({ model: { modelId: 'test' } })),
  reserve: vi.fn(),
  settle: vi.fn(),
  release: vi.fn(),
}));

vi.mock('ai', () => ({ generateText: mocks.generateText }));
vi.mock('~/lib/.server/agent-request-identity', () => ({
  resolveAgentRequestIdentity: mocks.resolveIdentity,
}));
vi.mock('~/lib/.server/cloudflare/workers-ai-billing-context', () => ({
  getUserWorkersAiCredentials: mocks.getCredentials,
}));
vi.mock('~/lib/.server/llm/provider', () => ({ getProvider: mocks.getProvider }));
vi.mock('~/lib/.server/billing/ai-allowance-repository', async (importOriginal) => {
  const original = await importOriginal<typeof AiAllowanceRepository>();
  return {
    ...original,
    reserveAiAllowance: mocks.reserve,
    settleAiAllowance: mocks.settle,
    releaseAiAllowance: mocks.release,
  };
});

import { enhancePromptAction } from './enhance-prompt';

function request() {
  return new Request('https://ghostbuild.dev/api/enhance-prompt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'Build a calendar' }),
  });
}

describe('enhancePromptAction billing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveIdentity.mockResolvedValue({ billingSubjectKey: 'user:user-1', ownerId: 'user-1', userId: 'user-1' });
    mocks.getCredentials.mockResolvedValue(undefined);
    mocks.reserve.mockResolvedValue({ id: 'reservation-1' });
    mocks.generateText.mockResolvedValue({
      text: 'Build a detailed calendar',
      totalUsage: { inputTokens: 20, outputTokens: 10 },
      providerMetadata: {},
    });
  });

  it('requires a guest or signed-in identity', async () => {
    mocks.resolveIdentity.mockResolvedValue(null);
    const response = await enhancePromptAction({ request: request(), env: {} as Env });
    expect(response.status).toBe(401);
    expect(mocks.generateText).not.toHaveBeenCalled();
  });

  it('reserves and settles Ghostbuild-funded inference', async () => {
    const response = await enhancePromptAction({ request: request(), env: { DB: {} } as Env });
    expect(response.status).toBe(200);
    expect(mocks.reserve).toHaveBeenCalledWith({}, 'user:user-1', expect.any(Number));
    expect(mocks.settle).toHaveBeenCalledWith({}, 'reservation-1', expect.any(Number), {
      inputTokens: 20,
      cachedInputTokens: 0,
      outputTokens: 10,
    });
  });

  it('uses connected-user credentials without consuming Ghostbuild allowance', async () => {
    const credentials = { accountId: 'account-1', apiKey: 'token' };
    mocks.getCredentials.mockResolvedValue(credentials);
    const response = await enhancePromptAction({ request: request(), env: { DB: {} } as Env });
    expect(response.status).toBe(200);
    expect(mocks.getProvider).toHaveBeenCalledWith({ DB: {} }, credentials);
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.settle).not.toHaveBeenCalled();
  });

  it('asks for explicit Workers Paid authorization when the connected free allocation is exhausted', async () => {
    mocks.getCredentials.mockResolvedValue({ accountId: 'account-1', apiKey: 'token' });
    mocks.generateText.mockRejectedValue(new Error('Workers Paid plan required after free AI allocation'));
    const response = await enhancePromptAction({ request: request(), env: { DB: {} } as Env });
    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toMatchObject({
      code: 'workers_paid_required',
      error: expect.stringContaining('GHOSTBUILD_WORKERS_PAID_REQUIRED:'),
    });
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
});
