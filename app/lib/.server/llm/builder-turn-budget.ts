import type { ModelToolName } from 'ghostbuild-agent/model-tool-inputs';

export const BUILDER_MUTATION_TOOL_TIMEOUT_MS = 35 * 60_000;

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

export class BuilderTurnBudgetExceededError extends Error {
  readonly code = BUILDER_TURN_BUDGET_ERROR_CODE;

  constructor(readonly reason: 'tool_timeout') {
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
