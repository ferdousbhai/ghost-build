import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class AgentTurnError extends Error {
    constructor(
      message: string,
      readonly statusCode?: number,
    ) {
      super(message);
    }
  }
  return {
    AgentTurnError,
    completeText: vi.fn(),
    getPiModel: vi.fn(() => ({ model: { id: 'workers-ai-model' }, stream: vi.fn() })),
  };
});
vi.mock('./pi-ai-invoke', () => ({ AgentTurnError: mocks.AgentTurnError, completeText: mocks.completeText }));
vi.mock('./pi-ai-models', () => ({ getPiModel: mocks.getPiModel }));

import { summarizeBuilderContext } from './workers-ai-text';

describe('summarizeBuilderContext', () => {
  const credentials = { accountId: 'account-1', apiKey: 'token' };

  beforeEach(() => vi.clearAllMocks());

  test('returns a trimmed readable summary using the connected account and cancellation signal', async () => {
    mocks.completeText.mockResolvedValue('  current state  ');
    const env = {} as Env;
    const signal = new AbortController().signal;
    await expect(summarizeBuilderContext(env, 'conversation', credentials, signal)).resolves.toBe('current state');
    expect(mocks.getPiModel).toHaveBeenCalled();
    expect(mocks.completeText).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ signal }));
  });

  test('retries one transient provider failure', async () => {
    mocks.completeText
      .mockRejectedValueOnce(new mocks.AgentTurnError('temporarily unavailable', 503))
      .mockResolvedValueOnce('recovered state');

    await expect(summarizeBuilderContext({} as Env, 'conversation', credentials)).resolves.toBe('recovered state');
    expect(mocks.completeText).toHaveBeenCalledTimes(2);
  });

  test('does not retry a deterministic provider failure', async () => {
    mocks.completeText.mockRejectedValue(new mocks.AgentTurnError('invalid request', 400));

    await expect(summarizeBuilderContext({} as Env, 'conversation', credentials)).rejects.toThrow(
      'Context compaction generation failed.',
    );
    expect(mocks.completeText).toHaveBeenCalledOnce();
  });

  test('uses a fixed safe error when generation fails', async () => {
    mocks.completeText.mockRejectedValue(new Error('provider detail'));
    await expect(summarizeBuilderContext({} as Env, 'conversation', credentials)).rejects.toThrow(
      'Context compaction generation failed.',
    );
  });
});
