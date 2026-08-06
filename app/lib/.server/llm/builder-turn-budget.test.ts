import { describe, expect, it } from 'vitest';
import {
  BUILDER_TURN_BUDGET_ERROR_CODE,
  BUILDER_TURN_MAX_MODEL_STEPS,
  BUILDER_TURN_TIMEOUTS,
  BuilderTurnBudgetExceededError,
  builderTurnStepBudgetExceeded,
  classifyBuilderTimeout,
} from './builder-turn-budget';

describe('builder turn budgets', () => {
  it('stops a looping model at the centralized step ceiling', () => {
    expect(builderTurnStepBudgetExceeded(BUILDER_TURN_MAX_MODEL_STEPS - 1, false)).toBe(false);
    expect(builderTurnStepBudgetExceeded(BUILDER_TURN_MAX_MODEL_STEPS, false)).toBe(true);
    expect(builderTurnStepBudgetExceeded(BUILDER_TURN_MAX_MODEL_STEPS + 20, false)).toBe(true);
  });

  it('lets a validated completion on the final allowed step win over exhaustion', () => {
    expect(builderTurnStepBudgetExceeded(BUILDER_TURN_MAX_MODEL_STEPS, true)).toBe(false);
  });

  it('keeps model, inactivity, tool, and total limits finite and ordered', () => {
    const toolTimeouts = [BUILDER_TURN_TIMEOUTS.toolMs, ...Object.values(BUILDER_TURN_TIMEOUTS.tools)];
    const longestToolTimeout = Math.max(...toolTimeouts);

    expect(BUILDER_TURN_TIMEOUTS.firstChunkMs).toBeLessThan(BUILDER_TURN_TIMEOUTS.stepMs);
    expect(BUILDER_TURN_TIMEOUTS.chunkMs).toBeLessThan(BUILDER_TURN_TIMEOUTS.stepMs);
    expect(BUILDER_TURN_TIMEOUTS.stepMs).toBeLessThan(BUILDER_TURN_TIMEOUTS.totalMs);
    for (const toolTimeoutMs of toolTimeouts) {
      expect(toolTimeoutMs).toBeLessThan(BUILDER_TURN_TIMEOUTS.chunkMs);
    }
    expect(BUILDER_TURN_TIMEOUTS.firstChunkMs + longestToolTimeout + 2 * 60_000).toBeLessThanOrEqual(
      BUILDER_TURN_TIMEOUTS.stepMs,
    );
  });

  it('distinguishes timeouts from user cancellation and exposes a typed retryable payload', () => {
    const timeout = classifyBuilderTimeout(new DOMException('Tool execution timed out', 'TimeoutError'));
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
