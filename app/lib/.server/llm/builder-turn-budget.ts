export const BUILDER_TURN_MAX_MODEL_STEPS = 32;

/**
 * One source of truth for every wall-clock limit applied to a builder loop.
 * The longest server-owned operation is the 10 minute deployment build, so a
 * step gets 15 minutes and the whole turn gets three such windows. Model
 * transport stalls are much shorter and do not share the user-cancel signal.
 */
export const BUILDER_TURN_TIMEOUTS = {
  totalMs: 45 * 60_000,
  stepMs: 15 * 60_000,
  firstChunkMs: 3 * 60_000,
  chunkMs: 2 * 60_000,
  toolMs: 6 * 60_000,
  tools: {
    readMs: 2 * 60_000,
    lsMs: 2 * 60_000,
    writeMs: 3 * 60_000,
    editMs: 3 * 60_000,
    execMs: 6 * 60_000,
    lookupDocsMs: 2 * 60_000,
    npmInstallMs: 6 * 60_000,
    validateProjectMs: 12 * 60_000,
    deployMs: 12 * 60_000,
  },
} as const;

export const BUILDER_TURN_BUDGET_ERROR_CODE = 'builder_turn_budget_exhausted';

export class BuilderTurnBudgetExceededError extends Error {
  readonly code = BUILDER_TURN_BUDGET_ERROR_CODE;

  constructor(readonly reason: 'model_steps' | 'total_timeout' | 'step_timeout' | 'stream_stall' | 'tool_timeout') {
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

export function builderTurnStepBudgetExceeded(stepCount: number, hasValidatedCompletion: boolean): boolean {
  return !hasValidatedCompletion && stepCount >= BUILDER_TURN_MAX_MODEL_STEPS;
}

export function classifyBuilderTimeout(error: unknown): BuilderTurnBudgetExceededError | null {
  if (!(error instanceof DOMException) || error.name !== 'TimeoutError') {
    return null;
  }
  const message = error.message.toLowerCase();
  const reason = message.includes('tool')
    ? 'tool_timeout'
    : message.includes('chunk')
      ? 'stream_stall'
      : message.includes('step')
        ? 'step_timeout'
        : 'total_timeout';
  return new BuilderTurnBudgetExceededError(reason);
}
