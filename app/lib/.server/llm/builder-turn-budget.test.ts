import { describe, expect, it } from 'vitest';
import {
  BUILDER_TURN_BUDGET_ERROR_CODE,
  BUILDER_MUTATION_TOOL_TIMEOUT_MS,
  BUILDER_TURN_TIMEOUTS,
  BuilderTurnBudgetExceededError,
  classifyBuilderTimeout,
} from './builder-turn-budget';

describe('builder turn budgets', () => {
  it('keeps every enforced operation below the total turn limit', () => {
    expect(BUILDER_TURN_TIMEOUTS.modelStreamMs).toBeLessThan(BUILDER_TURN_TIMEOUTS.totalMs);
    for (const timeoutMs of Object.values(BUILDER_TURN_TIMEOUTS.tools)) {
      expect(timeoutMs).toBeGreaterThan(0);
      expect(timeoutMs).toBeLessThan(BUILDER_TURN_TIMEOUTS.totalMs);
    }
    expect(BUILDER_MUTATION_TOOL_TIMEOUT_MS).toBeGreaterThan(30 * 60_000);
  });

  it('distinguishes timeouts from user cancellation and exposes a typed retryable payload', () => {
    const timeout = classifyBuilderTimeout(new DOMException('Signal timed out', 'TimeoutError'), 'tool_timeout');
    expect(timeout).toBeInstanceOf(BuilderTurnBudgetExceededError);
    expect(timeout?.reason).toBe('tool_timeout');
    expect(JSON.parse(timeout?.message ?? '{}')).toMatchObject({
      code: BUILDER_TURN_BUDGET_ERROR_CODE,
      reason: 'tool_timeout',
      retryable: true,
    });
    expect(classifyBuilderTimeout(new DOMException('Cancelled by owner', 'AbortError'))).toBeNull();
  });
});
