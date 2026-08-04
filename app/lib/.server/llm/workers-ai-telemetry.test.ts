import { describe, expect, test, vi } from 'vitest';
import { recordWorkersAiFinish, workersAiPromptCacheTelemetry } from './workers-ai-telemetry';

describe('Workers AI prompt-cache telemetry', () => {
  test('distinguishes hit, miss, and unavailable AI SDK usage', () => {
    expect(workersAiPromptCacheTelemetry({ inputTokenDetails: { cacheReadTokens: 800 } }, true, 1_000)).toEqual({
      attempted: true,
      status: 'hit',
      cachedInputTokens: 800,
      estimatedSavingsNanodollars: 912_000,
    });
    expect(workersAiPromptCacheTelemetry({ inputTokenDetails: { cacheReadTokens: 0 } }, true, 1_000)).toMatchObject({
      attempted: true,
      status: 'miss',
      cachedInputTokens: 0,
    });
    expect(workersAiPromptCacheTelemetry({}, true, 1_000)).toMatchObject({
      attempted: true,
      status: 'unavailable',
      cachedInputTokens: 0,
    });
  });

  test('retains compatibility with raw Workers AI usage metadata', () => {
    expect(workersAiPromptCacheTelemetry({ prompt_tokens_details: { cached_tokens: 120 } }, true, 200)).toMatchObject({
      status: 'hit',
      cachedInputTokens: 120,
    });
    expect(workersAiPromptCacheTelemetry({ inputTokenDetails: { cacheReadTokens: 120 } }, true, 0)).toMatchObject({
      status: 'miss',
      cachedInputTokens: 0,
    });
  });

  test('does not infer a cache attempt or savings and clamps invalid input usage', () => {
    expect(workersAiPromptCacheTelemetry({ inputTokenDetails: { cacheReadTokens: 120 } }, false, 200)).toEqual({
      attempted: false,
      status: 'unavailable',
      cachedInputTokens: 0,
      estimatedSavingsNanodollars: 0,
    });
    expect(workersAiPromptCacheTelemetry({ inputTokenDetails: { cacheReadTokens: 120 } }, true, -20)).toEqual({
      attempted: true,
      status: 'miss',
      cachedInputTokens: 0,
      estimatedSavingsNanodollars: 0,
    });
  });

  test('records the cache-read field emitted by AI SDK 7 usage', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    recordWorkersAiFinish({
      result: {
        finishReason: 'stop',
        usage: {
          inputTokens: 1_000,
          outputTokens: 20,
          totalTokens: 1_020,
          inputTokenDetails: { noCacheTokens: 200, cacheReadTokens: 800, cacheWriteTokens: undefined },
        },
        finalStep: { providerMetadata: undefined },
      } as never,
      chatInitialId: 'chat',
      firstUserMessage: false,
      contextReduced: false,
      estimatedContextTokens: 900,
      promptCharacterCounts: { messageHistoryChars: 30, currentTurnChars: 20, totalPromptChars: 60 },
      providerModel: '@cf/zai-org/glm-5.2',
      promptCacheAttempted: true,
      modelInputFingerprint: 'opaque',
      startedAt: Date.now(),
    });

    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        promptCache: {
          attempted: true,
          status: 'hit',
          cachedInputTokens: 800,
          estimatedSavingsNanodollars: 912_000,
        },
      }),
    );
    info.mockRestore();
  });
});
