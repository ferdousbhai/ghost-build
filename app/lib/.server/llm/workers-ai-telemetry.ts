import { cachedPromptTokenCount } from 'ghostbuild-agent/ai-compat';
import type { PromptCharacterCounts } from 'ghostbuild-agent/context-message-metrics';
import type { GenerateTextEndEvent, ToolSet } from 'ai';
import type { WorkersAiPromptCacheStatus } from './workers-ai-prompt-cache';

interface FinishTelemetryOptions {
  result: GenerateTextEndEvent<ToolSet>;
  firstUserMessage: boolean;
  contextReduced: boolean;
  estimatedContextTokens?: number;
  promptCharacterCounts: PromptCharacterCounts;
  providerModel: string;
  promptCacheAttempted: boolean;
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
    firstUserMessage: options.firstUserMessage,
    model: options.providerModel,
    finishReason: result.finishReason,
    usage,
    contextReduced: options.contextReduced,
    estimatedContextTokens: options.estimatedContextTokens,
    promptCharacterCounts: options.promptCharacterCounts,
    durationMs: Date.now() - options.startedAt,
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
} {
  const normalizedInputTokens = normalizeUsage(inputTokens);
  if (!attempted) {
    return {
      attempted: false,
      status: 'unavailable',
      cachedInputTokens: 0,
    };
  }
  const reportedCachedTokens = cachedPromptTokenCount(usageAndProviderMetadata);
  const cachedInputTokens = Math.min(normalizedInputTokens, reportedCachedTokens ?? 0);
  const status: WorkersAiPromptCacheStatus =
    reportedCachedTokens === undefined ? 'unavailable' : cachedInputTokens > 0 ? 'hit' : 'miss';
  return {
    attempted,
    status,
    cachedInputTokens,
  };
}

export function recordFirstWorkersAiResponse(startedAt: number): void {
  const timeToFirstResponse = Date.now() - startedAt;
  console.info({
    event: 'workers_ai_first_response',
    timeToFirstResponseMs: timeToFirstResponse,
    platform: 'Cloudflare AI',
  });
}

function normalizeUsage(usage: number | undefined): number {
  return usage === undefined || !Number.isFinite(usage) || usage < 0 ? 0 : usage;
}
