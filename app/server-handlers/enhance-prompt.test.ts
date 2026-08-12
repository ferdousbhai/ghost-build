import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  completeText: vi.fn(),
  getCredentials: vi.fn(),
  getPiProvider: vi.fn(() => ({ handle: { model: { id: 'test' } } })),
}));

vi.mock('~/lib/.server/cloudflare/workers-ai-billing-context', () => ({
  getUserWorkersAiCredentials: mocks.getCredentials,
}));
vi.mock('~/lib/.server/llm/provider', () => ({ getPiProvider: mocks.getPiProvider }));
vi.mock('~/lib/.server/llm/pi-ai-invoke', () => ({ completeText: mocks.completeText }));

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
    mocks.getCredentials.mockResolvedValue({ binding: {} as Ai });
    mocks.completeText.mockResolvedValue('Build a detailed calendar');
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
    expect(mocks.completeText).not.toHaveBeenCalled();
  });

  it('uses only the user-runtime binding', async () => {
    const credentials = { binding: {} as Ai };
    mocks.getCredentials.mockResolvedValue(credentials);
    const response = await userRuntimeEnhPrompt({ request: request(), env: { DB: {} } as Env });
    expect(response.status).toBe(200);
    expect(mocks.getPiProvider).toHaveBeenCalledWith(credentials);
  });

  it('asks for explicit Workers Paid authorization when the connected free allocation is exhausted', async () => {
    mocks.getCredentials.mockResolvedValue({ binding: {} as Ai });
    mocks.completeText.mockRejectedValue(new Error('Workers Paid plan required after free AI allocation'));
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
    mocks.completeText.mockRejectedValue(providerError);

    const response = await userRuntimeEnhPrompt({ request: request(), env: { DB: {} } as Env });

    expect(response.status).toBe(500);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('SECRET_PROMPT_MARKER');
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('provider failure');
    consoleError.mockRestore();
  });

  it('rejects an empty provider result instead of returning the original prompt as a successful enhancement', async () => {
    mocks.completeText.mockResolvedValue('   ');

    const response = await userRuntimeEnhPrompt({ request: request(), env: { DB: {} } as Env });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Error enhancing prompt' });
  });
});

function userRuntimeEnhPrompt(args: { request: Request; env: Env }) {
  return userRuntimeEnhancePromptAction({ ...args, userId: 'user-1' });
}
