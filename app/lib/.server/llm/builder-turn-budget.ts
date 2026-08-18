import type { ModelToolName } from 'ghostbuild-agent/model-tool-inputs';

export const BUILDER_MUTATION_TOOL_TIMEOUT_MS = 35 * 60_000;

/**
 * One step is a model response plus the tool batch it requested. Validated
 * builds converge well inside forty steps, so this ceiling only bites on a
 * model that keeps calling tools or failing validation without progressing.
 */
export const BUILDER_TURN_MAX_MODEL_STEPS = 150;

/**
 * Hard deadline for the whole turn. It has to clear two back-to-back mutation
 * tool deadlines plus the model time around them, and stay far below the
 * multi-hour ceiling the loop previously ran with.
 */
export const BUILDER_TURN_WALL_CLOCK_MS = 90 * 60_000;

/**
 * No model or tool event at all for this long means the turn is wedged. Tools
 * carry their own deadlines, so this watchdog only covers the gaps between them.
 */
export const BUILDER_TURN_INACTIVITY_MS = 5 * 60_000;

/** Product deadlines enforced cooperatively by the shared Pi tool adapter. */
export const BUILDER_TURN_TIMEOUTS = {
  tools: {
    read: 2 * 60_000,
    write: BUILDER_MUTATION_TOOL_TIMEOUT_MS,
    edit: BUILDER_MUTATION_TOOL_TIMEOUT_MS,
    exec: BUILDER_MUTATION_TOOL_TIMEOUT_MS,
  } satisfies Record<ModelToolName, number>,
} as const;

export const BUILDER_TURN_BUDGET_ERROR_CODE = 'builder_turn_budget_exhausted';

export type BuilderTurnBudgetReason = 'tool_timeout' | 'max_steps' | 'wall_clock' | 'inactivity';

export type BuilderTurnTerminalReason = BuilderTurnBudgetReason | 'completed' | 'cancelled' | 'failed';

/** Content-free turn accounting. Never carries prompt or generated code. */
export type BuilderTurnBudgetReport = {
  terminalReason: BuilderTurnTerminalReason;
  stepCount: number;
  toolCallCount: number;
  elapsedMs: number;
  lastValidationState: 'validated' | 'unvalidated';
};

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
