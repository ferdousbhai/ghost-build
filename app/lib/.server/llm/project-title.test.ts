import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getPiModel: vi.fn(() => ({ model: { id: 'title-model' }, stream: vi.fn() })),
  completeText: vi.fn(),
  titleGeneration: vi.fn(),
}));

vi.mock('./pi-ai-models', () => ({ getPiModel: mocks.getPiModel }));
vi.mock('@summonghost/title-generation', () => ({
  generateTitle: (...args: unknown[]) => mocks.titleGeneration(...args),
}));
vi.mock('./pi-ai-invoke', () => ({ completeText: mocks.completeText }));

import { generateProjectTitle } from './project-title';

describe('generateProjectTitle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.titleGeneration.mockResolvedValue({ title: 'Cloudflare Verification App' });
  });

  it('uses the connected account with the small title model', async () => {
    const credentials = { accountId: 'account-1', apiKey: 'token' };
    const env = {} as Env;
    return expect(generateProjectTitle(env, 'Build a verification app', credentials)).resolves.toBe(
      'Cloudflare Verification App',
    );
  });

  it('propagates provider failures', async () => {
    mocks.titleGeneration.mockRejectedValue(new Error('model unavailable'));
    await expect(
      generateProjectTitle({} as Env, 'Build a calendar', { accountId: 'account-1', apiKey: 'token' }),
    ).rejects.toThrow('model unavailable');
  });

  it('adapts the shared title request to the Pi text result contract', async () => {
    mocks.completeText.mockResolvedValue('Focus Timer');
    mocks.titleGeneration.mockImplementation(
      async (input: {
        execute: (request: {
          prompt: string;
          maxOutputTokens: number;
          temperature: number;
        }) => Promise<{ text: string }>;
      }) => ({
        title: (await input.execute({ prompt: 'Shared title prompt', maxOutputTokens: 24, temperature: 0 })).text,
      }),
    );

    await expect(
      generateProjectTitle({} as Env, 'Build a timer', { accountId: 'account-1', apiKey: 'token' }),
    ).resolves.toBe('Focus Timer');
    expect(mocks.completeText).toHaveBeenCalledWith(expect.anything(), {
      prompt: 'Shared title prompt',
      maxTokens: 24,
    });
  });
});
