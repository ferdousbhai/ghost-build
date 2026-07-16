import { describe, expect, it } from 'vitest';
import { normalizeWorkersAiUsage } from './workers-ai-usage';

describe('normalizeWorkersAiUsage', () => {
  it('normalizes invalid usage and caps cached input at total input', () => {
    expect(
      normalizeWorkersAiUsage({ inputTokens: 10, outputTokens: Number.NaN }, { usage: { cachedInputTokens: 20 } }),
    ).toEqual({ inputTokens: 10, cachedInputTokens: 10, outputTokens: 0 });
  });
});
