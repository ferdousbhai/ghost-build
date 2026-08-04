/** Shared output ceiling supported by every model in the Ghostbuild builder catalog. */
export const MODEL_MAX_OUTPUT_TOKENS = 24_576;

/**
 * Conservative preflight ceiling for the Agents SDK's heuristic estimator.
 * This is intentionally below the smallest catalog context because the estimator is not model-specific.
 */
export const MAX_ESTIMATED_MODEL_INPUT_TOKENS = 100_000;

/** Generated workspace context is turn-local and must remain bounded. */
export const MAX_EPHEMERAL_CONTEXT_CHARACTERS = 80_000;

/** User-authored prompt text is bounded independently from generated workspace context. */
export const MAX_USER_MESSAGE_CHARACTERS = 32_000;
