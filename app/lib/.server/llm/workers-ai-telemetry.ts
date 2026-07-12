import { cachedPromptTokens } from 'ghostbuild-agent/ai-compat';
import type { PromptCharacterCounts } from 'ghostbuild-agent/context-message-metrics';
import { logger } from 'ghostbuild-agent/utils/logger';
import type { OnFinishEvent, ToolSet } from 'ai';

interface FinishTelemetryOptions {
  result: OnFinishEvent<ToolSet>;
  chatInitialId: string;
  firstUserMessage: boolean;
  toolsDisabledFromRepeatedErrors: boolean;
  contextReduced: boolean;
  estimatedContextTokens?: number;
  modelInputDroppedMessageCount?: number;
  promptCharacterCounts: PromptCharacterCounts;
  providerModel: string;
}

export function recordWorkersAiFinish(options: FinishTelemetryOptions): void {
  const { result } = options;
  const finalUsage = result.totalUsage;
  const usage = {
    outputTokens: normalizeUsage(finalUsage.outputTokens),
    inputTokens: normalizeUsage(finalUsage.inputTokens),
    totalTokens: normalizeUsage(finalUsage.totalTokens),
  };
  const event = {
    event: 'workers_ai_finished',
    chatInitialId: options.chatInitialId,
    firstUserMessage: options.firstUserMessage,
    model: options.providerModel,
    finishReason: result.finishReason,
    usage,
    contextReduced: options.contextReduced,
    estimatedContextTokens: options.estimatedContextTokens,
    modelInputDroppedMessageCount: options.modelInputDroppedMessageCount ?? 0,
    promptCharacterCounts: options.promptCharacterCounts,
    cachedPromptTokens: cachedPromptTokens(result.providerMetadata),
    toolsDisabledFromRepeatedErrors: options.toolsDisabledFromRepeatedErrors,
  };
  console.info(event);
  if (options.toolsDisabledFromRepeatedErrors) {
    logger.warn('Tools disabled because of repeated errors');
  }
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
  return usage === undefined || Number.isNaN(usage) ? 0 : usage;
}
