import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  getProvider: vi.fn(() => ({ model: { modelId: 'workers-ai-model' } })),
}));
vi.mock('ai', () => ({ generateText: mocks.generateText }));
vi.mock('./provider', () => ({ getProvider: mocks.getProvider }));

import { summarizeBuilderContext } from './workers-ai-text';

describe('summarizeBuilderContext', () => {
  const credentials = { accountId: 'account-1', apiKey: 'token' };

  beforeEach(() => vi.clearAllMocks());

  test('returns a trimmed readable summary using the connected account', async () => {
    mocks.generateText.mockResolvedValue({ text: '  current state  ' });
    const env = {} as Env;
    await expect(summarizeBuilderContext(env, 'conversation', credentials)).resolves.toBe('current state');
    expect(mocks.getProvider).toHaveBeenCalledWith(env, credentials);
  });

  test('uses a fixed safe error when generation fails', async () => {
    mocks.generateText.mockRejectedValue(new Error('provider detail'));
    await expect(summarizeBuilderContext({} as Env, 'conversation', credentials)).rejects.toThrow(
      'Context compaction generation failed.',
    );
  });
});
