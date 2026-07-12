/** GLM-5.2 output limit used by the Ghostbuild agent. */
export const MODEL_MAX_OUTPUT_TOKENS = 24_576;

/**
 * Conservative preflight ceiling for the Agents SDK's heuristic estimator.
 * This is intentionally below theoretical capacity because it is not a GLM tokenizer.
 */
export const MAX_ESTIMATED_MODEL_INPUT_TOKENS = 100_000;

/** Generated workspace context is turn-local and must remain bounded. */
export const MAX_EPHEMERAL_CONTEXT_CHARACTERS = 80_000;
