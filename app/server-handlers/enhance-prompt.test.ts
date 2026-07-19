import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  resolveIdentity: vi.fn(),
  getCredentials: vi.fn(),
  getProvider: vi.fn(() => ({ model: { modelId: 'test' } })),
}));

vi.mock('ai', () => ({ generateText: mocks.generateText }));
vi.mock('~/lib/.server/agent-request-identity', () => ({
  resolveAgentRequestIdentity: mocks.resolveIdentity,
}));
vi.mock('~/lib/.server/cloudflare/workers-ai-billing-context', () => ({
  getUserWorkersAiCredentials: mocks.getCredentials,
}));
vi.mock('~/lib/.server/llm/provider', () => ({ getProvider: mocks.getProvider }));

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
    mocks.resolveIdentity.mockResolvedValue({ ownerId: 'user-1', userId: 'user-1' });
    mocks.getCredentials.mockResolvedValue({ accountId: 'account-1', apiKey: 'token' });
    mocks.generateText.mockResolvedValue({
      text: 'Build a detailed calendar',
      totalUsage: { inputTokens: 20, outputTokens: 10 },
      providerMetadata: {},
    });
  });

  it('requires a Cloudflare-backed identity', async () => {
    mocks.resolveIdentity.mockResolvedValue(null);
    const unauthenticatedRequest = request();
    const response = await enhancePromptAction({ request: unauthenticatedRequest, env: {} as Env });
    expect(response.status).toBe(401);
    expect(unauthenticatedRequest.bodyUsed).toBe(false);
    expect(mocks.generateText).not.toHaveBeenCalled();
  });

  it('rejects an oversized prompt body before calling the provider', async () => {
    const response = await enhancePromptAction({
      request: new Request('https://ghostbuild.dev/api/enhance-prompt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'x'.repeat(70 * 1024) }),
      }),
      env: { DB: {} } as Env,
    });

    expect(response.status).toBe(413);
    expect(mocks.generateText).not.toHaveBeenCalled();
  });

  it('uses only connected-user credentials', async () => {
    const credentials = { accountId: 'account-1', apiKey: 'token' };
    mocks.getCredentials.mockResolvedValue(credentials);
    const response = await enhancePromptAction({ request: request(), env: { DB: {} } as Env });
    expect(response.status).toBe(200);
    expect(mocks.getProvider).toHaveBeenCalledWith({ DB: {} }, credentials);
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
  });

  it('does not log provider request bodies when prompt enhancement fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const providerError = Object.assign(new Error('provider failure'), {
      requestBodyValues: { prompt: 'SECRET_PROMPT_MARKER' },
    });
    mocks.generateText.mockRejectedValue(providerError);

    const response = await enhancePromptAction({ request: request(), env: { DB: {} } as Env });

    expect(response.status).toBe(500);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('SECRET_PROMPT_MARKER');
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('provider failure');
    consoleError.mockRestore();
  });
});
