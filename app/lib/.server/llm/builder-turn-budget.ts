export const BUILDER_TURN_MAX_MODEL_STEPS = 32;

/** Limits that are actively enforced by the Pi loop and tool adapter. */
export const BUILDER_TURN_TIMEOUTS = {
  totalMs: 60 * 60_000,
  modelStreamMs: 13 * 60_000,
  tools: {
    read: 2 * 60_000,
    write: 12 * 60_000,
    edit: 12 * 60_000,
    exec: 12 * 60_000,
  },
} as const;

export const BUILDER_TURN_BUDGET_ERROR_CODE = 'builder_turn_budget_exhausted';
type BuilderTurnBudgetReason = 'model_steps' | 'total_timeout' | 'stream_stall' | 'tool_timeout';

export class BuilderTurnBudgetExceededError extends Error {
  readonly code = BUILDER_TURN_BUDGET_ERROR_CODE;

  constructor(readonly reason: BuilderTurnBudgetReason) {
    super(
      JSON.stringify({
        code: BUILDER_TURN_BUDGET_ERROR_CODE,
        error: 'This build reached its safe execution limit before it finished. Send a follow-up to continue.',
        reason,
        retryable: true,
      }),
    );
    this.name = 'BuilderTurnBudgetExceededError';
  }
}

export function classifyBuilderTimeout(
  error: unknown,
  fallbackReason: BuilderTurnBudgetReason = 'stream_stall',
): BuilderTurnBudgetExceededError | null {
  if (!(error instanceof DOMException) || error.name !== 'TimeoutError') {
    return null;
  }
  return new BuilderTurnBudgetExceededError(fallbackReason);
}
