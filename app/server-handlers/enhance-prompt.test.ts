import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  getCredentials: vi.fn(),
  getProvider: vi.fn(() => ({ model: { modelId: 'test' } })),
}));

vi.mock('ai', () => ({ generateText: mocks.generateText }));
vi.mock('~/lib/.server/cloudflare/workers-ai-billing-context', () => ({
  getUserWorkersAiCredentials: mocks.getCredentials,
}));
vi.mock('~/lib/.server/llm/provider', () => ({ getProvider: mocks.getProvider }));

import { userRuntimeEnhancePromptAction } from './enhance-prompt';

function request() {
  return new Request('https://ghostbuild.dev/api/enhance-prompt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'Build a calendar' }),
  });
}

describe('userRuntimeEnhancePromptAction billing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCredentials.mockResolvedValue({ accountId: 'account-1', apiKey: 'token' });
    mocks.generateText.mockResolvedValue({
      text: 'Build a detailed calendar',
      usage: { inputTokens: 20, outputTokens: 10 },
      finalStep: { providerMetadata: {} },
    });
  });

  it('rejects an oversized prompt body before calling the provider', async () => {
    const response = await userRuntimeEnhPrompt({
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
    const response = await userRuntimeEnhPrompt({ request: request(), env: { DB: {} } as Env });
    expect(response.status).toBe(200);
    expect(mocks.getProvider).toHaveBeenCalledWith({ DB: {} }, credentials, undefined, {
      feature: 'prompt-enhancement',
    });
  });

  it('asks for explicit Workers Paid authorization when the connected free allocation is exhausted', async () => {
    mocks.getCredentials.mockResolvedValue({ accountId: 'account-1', apiKey: 'token' });
    mocks.generateText.mockRejectedValue(new Error('Workers Paid plan required after free AI allocation'));
    const response = await userRuntimeEnhPrompt({ request: request(), env: { DB: {} } as Env });
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

    const response = await userRuntimeEnhPrompt({ request: request(), env: { DB: {} } as Env });

    expect(response.status).toBe(500);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('SECRET_PROMPT_MARKER');
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('provider failure');
    consoleError.mockRestore();
  });

  it('rejects an empty provider result instead of returning the original prompt as a successful enhancement', async () => {
    mocks.generateText.mockResolvedValue({ text: '   ' });

    const response = await userRuntimeEnhPrompt({ request: request(), env: { DB: {} } as Env });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Error enhancing prompt' });
  });
});

function userRuntimeEnhPrompt(args: { request: Request; env: Env }) {
  return userRuntimeEnhancePromptAction({ ...args, userId: 'user-1' });
}
