import { cachedPromptTokenCount } from 'ghostbuild-agent/ai-compat';
import type { PromptCharacterCounts } from 'ghostbuild-agent/context-message-metrics';
import type { GenerateTextEndEvent, ToolSet } from 'ai';
import type { WorkersAiPromptCacheStatus } from './workers-ai-prompt-cache';

const GLM_5_2_NANODOLLARS_PER_INPUT_TOKEN = 1_400;
const GLM_5_2_NANODOLLARS_PER_CACHED_INPUT_TOKEN = 260;

interface FinishTelemetryOptions {
  result: GenerateTextEndEvent<ToolSet>;
  chatInitialId: string;
  firstUserMessage: boolean;
  contextReduced: boolean;
  estimatedContextTokens?: number;
  promptCharacterCounts: PromptCharacterCounts;
  providerModel: string;
  promptCacheAttempted: boolean;
  modelInputFingerprint: string;
  startedAt: number;
}

export function recordWorkersAiFinish(options: FinishTelemetryOptions): void {
  const { result } = options;
  const finalUsage = result.usage;
  const usage = {
    outputTokens: normalizeUsage(finalUsage.outputTokens),
    inputTokens: normalizeUsage(finalUsage.inputTokens),
    totalTokens: normalizeUsage(finalUsage.totalTokens),
  };
  const cache = workersAiPromptCacheTelemetry(
    [result.usage, result.finalStep.providerMetadata],
    options.promptCacheAttempted,
    usage.inputTokens,
  );
  const event = {
    event: 'workers_ai_finished',
    chatInitialId: options.chatInitialId,
    firstUserMessage: options.firstUserMessage,
    model: options.providerModel,
    finishReason: result.finishReason,
    usage,
    contextReduced: options.contextReduced,
    estimatedContextTokens: options.estimatedContextTokens,
    promptCharacterCounts: options.promptCharacterCounts,
    durationMs: Date.now() - options.startedAt,
    modelInputFingerprint: options.modelInputFingerprint,
    promptCache: cache,
  };
  console.info(event);
}

export function workersAiPromptCacheTelemetry(
  usageAndProviderMetadata: unknown,
  attempted: boolean,
  inputTokens: number,
): {
  attempted: boolean;
  status: WorkersAiPromptCacheStatus;
  cachedInputTokens: number;
  estimatedSavingsNanodollars: number;
} {
  const normalizedInputTokens = normalizeUsage(inputTokens);
  if (!attempted) {
    return {
      attempted: false,
      status: 'unavailable',
      cachedInputTokens: 0,
      estimatedSavingsNanodollars: 0,
    };
  }
  const reportedCachedTokens = cachedPromptTokenCount(usageAndProviderMetadata);
  const cachedInputTokens = Math.min(normalizedInputTokens, reportedCachedTokens ?? 0);
  const status: WorkersAiPromptCacheStatus =
    reportedCachedTokens === undefined ? 'unavailable' : cachedInputTokens > 0 ? 'hit' : 'miss';
  const uncachedCost = normalizedInputTokens * GLM_5_2_NANODOLLARS_PER_INPUT_TOKEN;
  const actualCost =
    (normalizedInputTokens - cachedInputTokens) * GLM_5_2_NANODOLLARS_PER_INPUT_TOKEN +
    cachedInputTokens * GLM_5_2_NANODOLLARS_PER_CACHED_INPUT_TOKEN;
  return {
    attempted,
    status,
    cachedInputTokens,
    estimatedSavingsNanodollars: uncachedCost - actualCost,
  };
}

export function recordFirstWorkersAiResponse(chatInitialId: string, startedAt: number): void {
  const timeToFirstResponse = Date.now() - startedAt;
  console.info({
    event: 'workers_ai_first_response',
    timeToFirstResponseMs: timeToFirstResponse,
    provider: 'Cloudflare',
    chatInitialId,
  });
}

function normalizeUsage(usage: number | undefined): number {
  return usage === undefined || !Number.isFinite(usage) || usage < 0 ? 0 : usage;
}
