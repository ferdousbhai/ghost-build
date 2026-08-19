import type { PromptCharacterCounts } from 'ghostbuild-agent/context-message-metrics';
import type { Usage } from '@earendil-works/pi-ai';

interface FinishTelemetryOptions {
  usage: Usage;
  finishReason: string;
  firstUserMessage: boolean;
  contextReduced: boolean;
  estimatedContextTokens?: number;
  promptCharacterCounts: PromptCharacterCounts;
  providerModel: string;
  startedAt: number;
}

export function recordWorkersAiFinish(options: FinishTelemetryOptions): void {
  const usage = {
    inputTokens: normalizeUsage(options.usage.input),
    outputTokens: normalizeUsage(options.usage.output),
    totalTokens: normalizeUsage(options.usage.totalTokens),
  };
  console.info({
    event: 'workers_ai_finished',
    firstUserMessage: options.firstUserMessage,
    model: options.providerModel,
    finishReason: options.finishReason,
    usage,
    contextReduced: options.contextReduced,
    estimatedContextTokens: options.estimatedContextTokens,
    promptCharacterCounts: options.promptCharacterCounts,
    durationMs: Date.now() - options.startedAt,
    promptCache: workersAiPromptCacheTelemetry(options.usage, usage.inputTokens),
  });
}

type WorkersAiPromptCacheTelemetry = {
  attempted: true;
  status: 'hit' | 'miss';
  cachedInputTokens: number;
};

export function workersAiPromptCacheTelemetry(usage: Usage, inputTokens: number): WorkersAiPromptCacheTelemetry {
  const cachedInputTokens = Math.min(normalizeUsage(inputTokens), normalizeUsage(usage.cacheRead));
  return {
    attempted: true,
    status: cachedInputTokens > 0 ? 'hit' : 'miss',
    cachedInputTokens,
  };
}

export function recordFirstWorkersAiResponse(startedAt: number): void {
  console.info({
    event: 'workers_ai_first_response',
    timeToFirstResponseMs: Date.now() - startedAt,
    platform: 'Cloudflare AI',
  });
}

function normalizeUsage(usage: number | undefined): number {
  return usage === undefined || !Number.isFinite(usage) || usage < 0 ? 0 : usage;
}
