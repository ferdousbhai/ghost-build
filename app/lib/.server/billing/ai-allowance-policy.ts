export const GHOSTBUILD_DAILY_AI_ALLOWANCE_USD = 1;
export const GHOSTBUILD_DAILY_AI_ALLOWANCE_NANODOLLARS = 1_000_000_000;

export const AI_ALLOWANCE_REMINDER_THRESHOLDS = [50, 90] as const;

export type AiAllowanceReminder = 0 | (typeof AI_ALLOWANCE_REMINDER_THRESHOLDS)[number];

type AiAllowanceStatus = {
  usedPercent: number;
  remainingNanodollars: number;
  exhausted: boolean;
  reminder: AiAllowanceReminder;
};

type WorkersAiTokenUsage = {
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
};

// @cf/zai-org/glm-5.2 prices as of 2026-07-08. Nano-dollars make
// the published per-million-token prices exact integer costs per token.
const GLM_5_2_NANODOLLARS_PER_INPUT_TOKEN = 1_400;
const GLM_5_2_NANODOLLARS_PER_CACHED_INPUT_TOKEN = 260;
const GLM_5_2_NANODOLLARS_PER_OUTPUT_TOKEN = 4_400;

// @cf/meta/llama-3.2-1b-instruct prices as of 2026-07-16.
const LLAMA_3_2_1B_NANODOLLARS_PER_INPUT_TOKEN = 27;
const LLAMA_3_2_1B_NANODOLLARS_PER_OUTPUT_TOKEN = 201;

export function glm52CostNanodollars(usage: WorkersAiTokenUsage): number {
  const inputTokens = nonnegativeInteger(usage.inputTokens, 'inputTokens');
  const cachedInputTokens = Math.min(
    inputTokens,
    nonnegativeInteger(usage.cachedInputTokens ?? 0, 'cachedInputTokens'),
  );
  const outputTokens = nonnegativeInteger(usage.outputTokens, 'outputTokens');
  const uncachedInputTokens = inputTokens - cachedInputTokens;

  return (
    uncachedInputTokens * GLM_5_2_NANODOLLARS_PER_INPUT_TOKEN +
    cachedInputTokens * GLM_5_2_NANODOLLARS_PER_CACHED_INPUT_TOKEN +
    outputTokens * GLM_5_2_NANODOLLARS_PER_OUTPUT_TOKEN
  );
}

export function llama32_1bCostNanodollars(usage: WorkersAiTokenUsage): number {
  const inputTokens = nonnegativeInteger(usage.inputTokens, 'inputTokens');
  const outputTokens = nonnegativeInteger(usage.outputTokens, 'outputTokens');
  return (
    inputTokens * LLAMA_3_2_1B_NANODOLLARS_PER_INPUT_TOKEN + outputTokens * LLAMA_3_2_1B_NANODOLLARS_PER_OUTPUT_TOKEN
  );
}

export function aiAllowanceStatus(chargedCostNanodollars: number, reservedCostNanodollars = 0): AiAllowanceStatus {
  const charged = nonnegativeInteger(chargedCostNanodollars, 'chargedCostNanodollars');
  const reserved = nonnegativeInteger(reservedCostNanodollars, 'reservedCostNanodollars');
  const used = charged + reserved;
  const usedPercent = Math.min(100, (used / GHOSTBUILD_DAILY_AI_ALLOWANCE_NANODOLLARS) * 100);

  return {
    usedPercent,
    remainingNanodollars: Math.max(0, GHOSTBUILD_DAILY_AI_ALLOWANCE_NANODOLLARS - used),
    exhausted: used >= GHOSTBUILD_DAILY_AI_ALLOWANCE_NANODOLLARS,
    reminder: usedPercent >= 90 ? 90 : usedPercent >= 50 ? 50 : 0,
  };
}

export function nextAiAllowanceReminder(
  chargedCostNanodollars: number,
  lastNotifiedThreshold: AiAllowanceReminder,
): AiAllowanceReminder {
  const reminder = aiAllowanceStatus(chargedCostNanodollars).reminder;
  return reminder > lastNotifiedThreshold ? reminder : 0;
}

function nonnegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative safe integer.`);
  }
  return value;
}
