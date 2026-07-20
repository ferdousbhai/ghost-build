import { describe, expect, test } from 'vitest';
import { workersAiPromptCacheTelemetry } from './workers-ai-telemetry';

describe('Workers AI prompt-cache telemetry', () => {
  test('distinguishes hit, miss, and unavailable provider metadata', () => {
    expect(
      workersAiPromptCacheTelemetry({ workersai: { prompt_tokens_details: { cached_tokens: 800 } } }, true, 1_000),
    ).toEqual({
      attempted: true,
      status: 'hit',
      cachedInputTokens: 800,
      estimatedSavingsNanodollars: 912_000,
    });
    expect(
      workersAiPromptCacheTelemetry({ workersai: { prompt_tokens_details: { cached_tokens: 0 } } }, true, 1_000),
    ).toMatchObject({ attempted: true, status: 'miss', cachedInputTokens: 0 });
    expect(workersAiPromptCacheTelemetry({}, true, 1_000)).toMatchObject({
      attempted: true,
      status: 'unavailable',
      cachedInputTokens: 0,
    });
  });
});
