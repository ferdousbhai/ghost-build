import { describe, expect, it } from 'vitest';
import {
  GHOSTBUILD_DAILY_AI_ALLOWANCE_NANODOLLARS,
  aiAllowanceStatus,
  glm52CostNanodollars,
  llama32_1bCostNanodollars,
  nextAiAllowanceReminder,
} from './ai-allowance-policy';

describe('AI allowance policy', () => {
  it('prices uncached, cached, and output tokens using exact nano-dollar units', () => {
    expect(glm52CostNanodollars({ inputTokens: 1_000, cachedInputTokens: 250, outputTokens: 100 })).toBe(
      750 * 1_400 + 250 * 260 + 100 * 4_400,
    );
  });

  it('caps cached input at total input usage', () => {
    expect(glm52CostNanodollars({ inputTokens: 10, cachedInputTokens: 20, outputTokens: 0 })).toBe(10 * 260);
  });

  it('prices the small project-title model separately from the builder model', () => {
    expect(llama32_1bCostNanodollars({ inputTokens: 1_000, outputTokens: 100 })).toBe(1_000 * 27 + 100 * 201);
  });

  it('encourages Cloudflare connection at 50% and reminds again at 90%', () => {
    expect(aiAllowanceStatus(GHOSTBUILD_DAILY_AI_ALLOWANCE_NANODOLLARS * 0.49).reminder).toBe(0);
    expect(aiAllowanceStatus(GHOSTBUILD_DAILY_AI_ALLOWANCE_NANODOLLARS * 0.5).reminder).toBe(50);
    expect(aiAllowanceStatus(GHOSTBUILD_DAILY_AI_ALLOWANCE_NANODOLLARS * 0.9).reminder).toBe(90);
  });

  it('emits each reminder only when crossing a new threshold', () => {
    expect(nextAiAllowanceReminder(GHOSTBUILD_DAILY_AI_ALLOWANCE_NANODOLLARS * 0.5, 0)).toBe(50);
    expect(nextAiAllowanceReminder(GHOSTBUILD_DAILY_AI_ALLOWANCE_NANODOLLARS * 0.7, 50)).toBe(0);
    expect(nextAiAllowanceReminder(GHOSTBUILD_DAILY_AI_ALLOWANCE_NANODOLLARS * 0.9, 50)).toBe(90);
  });

  it('includes active reservations when deciding whether the daily dollar is exhausted', () => {
    const status = aiAllowanceStatus(
      GHOSTBUILD_DAILY_AI_ALLOWANCE_NANODOLLARS * 0.8,
      GHOSTBUILD_DAILY_AI_ALLOWANCE_NANODOLLARS * 0.2,
    );
    expect(status.exhausted).toBe(true);
    expect(status.remainingNanodollars).toBe(0);
  });
});
