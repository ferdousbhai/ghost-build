import { cachedPromptTokens } from 'ghostbuild-agent/ai-compat';

type WorkersAiTokenUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

export function normalizeWorkersAiUsage(
  usage: { inputTokens?: number; outputTokens?: number },
  providerMetadata?: unknown,
): WorkersAiTokenUsage {
  const inputTokens = nonnegativeSafeInteger(usage.inputTokens);
  return {
    inputTokens,
    cachedInputTokens: Math.min(inputTokens, nonnegativeSafeInteger(cachedPromptTokens(providerMetadata))),
    outputTokens: nonnegativeSafeInteger(usage.outputTokens),
  };
}

function nonnegativeSafeInteger(value: number | undefined): number {
  return value === undefined || !Number.isSafeInteger(value) || value < 0 ? 0 : value;
}
