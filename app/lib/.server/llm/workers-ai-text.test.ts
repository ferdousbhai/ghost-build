import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  completeText: vi.fn(),
  getPiModel: vi.fn(() => ({ model: { id: 'workers-ai-model' }, stream: vi.fn() })),
}));
vi.mock('./pi-ai-invoke', () => ({ completeText: mocks.completeText }));
vi.mock('./pi-ai-models', () => ({ getPiModel: mocks.getPiModel }));

import { summarizeBuilderContext } from './workers-ai-text';

describe('summarizeBuilderContext', () => {
  const credentials = { accountId: 'account-1', apiKey: 'token' };

  beforeEach(() => vi.clearAllMocks());

  test('returns a trimmed readable summary using the connected account', async () => {
    mocks.completeText.mockResolvedValue('  current state  ');
    const env = {} as Env;
    await expect(summarizeBuilderContext(env, 'conversation', credentials)).resolves.toBe('current state');
    expect(mocks.getPiModel).toHaveBeenCalled();
  });

  test('uses a fixed safe error when generation fails', async () => {
    mocks.completeText.mockRejectedValue(new Error('provider detail'));
    await expect(summarizeBuilderContext({} as Env, 'conversation', credentials)).rejects.toThrow(
      'Context compaction generation failed.',
    );
  });
});
