import { streamText, type UIMessageChunk } from 'ai';
import { ROLE_SYSTEM_PROMPT, generalSystemPrompt } from 'ghostbuild-agent/prompts/system';
import { deployTool } from 'ghostbuild-agent/tools/deploy';
import { viewTool } from 'ghostbuild-agent/tools/view';
import type { GhostbuildToolSet } from 'ghostbuild-agent/types';
import { npmInstallTool } from 'ghostbuild-agent/tools/npmInstall';
import type { Tracer } from '~/lib/.server/chat';
import { editTool } from 'ghostbuild-agent/tools/edit';
import { logger } from 'ghostbuild-agent/utils/logger';
import { getProvider } from '~/lib/.server/llm/provider';
import { lookupDocsTool } from 'ghostbuild-agent/tools/lookupDocs';
import type { PromptCharacterCounts } from 'ghostbuild-agent/ChatContextManager';
import { cachedPromptTokens, languageModelId, type GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { CLOUDFLARE_WORKERS_AI_MODEL } from '~/lib/workers-ai-model';
import { asAiSdkTools, asOriginalMessages, cleanupAssistantMessages } from './message-conversion';

type Messages = GhostbuildMessage[];

export async function workersAiAgent(args: {
  env: Env;
  abortSignal?: AbortSignal;
  chatInitialId: string;
  firstUserMessage: boolean;
  messages: Messages;
  promptMessages?: Messages;
  tracer: Tracer | null;
  shouldDisableTools: boolean;
  collapsedMessages: boolean;
  promptCharacterCounts?: PromptCharacterCounts;
}) {
  const {
    env,
    abortSignal,
    chatInitialId,
    firstUserMessage,
    messages,
    promptMessages = messages,
    tracer,
    shouldDisableTools,
    collapsedMessages,
    promptCharacterCounts,
  } = args;
  logger.debug('Starting Workers AI agent');
  const startTime = Date.now();
  let firstResponseTime: number | null = null;

  const provider = getProvider(env);
  const tools: GhostbuildToolSet = {
    deploy: deployTool,
    npmInstall: npmInstallTool,
    lookupDocs: lookupDocsTool(),
  };
  tools.view = viewTool;
  tools.edit = editTool;
  const aiSdkTools = asAiSdkTools(tools);

  const messagesForDataStream = [
    {
      role: 'system' as const,
      content: ROLE_SYSTEM_PROMPT,
    },
    {
      role: 'system' as const,
      content: generalSystemPrompt(),
    },
    ...(await cleanupAssistantMessages(promptMessages, tools)),
  ];

  const result = streamText({
    model: provider.model,
    abortSignal,
    maxOutputTokens: provider.maxTokens,
    messages: messagesForDataStream,
    tools: aiSdkTools,
    toolChoice: shouldDisableTools ? 'none' : 'auto',
    onChunk: () => {
      if (firstResponseTime !== null) {
        return;
      }
      firstResponseTime = Date.now();
      const timeToFirstResponse = firstResponseTime - startTime;
      if (tracer) {
        const span = tracer.startSpan('first-response');
        span.setAttribute('chatInitialId', chatInitialId);
        span.setAttribute('timeToFirstResponse', timeToFirstResponse);
        span.setAttribute('provider', 'Cloudflare');
        span.end();
      }
      logger.debug('First response metrics:', {
        timeToFirstResponse: `${timeToFirstResponse}ms`,
        provider: 'Cloudflare',
        chatInitialId,
      });
    },
    onFinish: (result) => {
      void onFinishHandler({
        result,
        tracer,
        chatInitialId,
        toolsDisabledFromRepeatedErrors: shouldDisableTools,
        collapsedMessages,
        promptCharacterCounts,
        _startTime: startTime,
        _firstResponseTime: firstResponseTime,
        providerModel: languageModelId(provider.model, CLOUDFLARE_WORKERS_AI_MODEL),
      });
    },
    onError({ error }) {
      logger.error(error);
    },
    experimental_telemetry: {
      isEnabled: true,
      functionId: `chat:Cloudflare:${firstUserMessage ? 'first-message' : 'follow-up'}:${chatInitialId}`,
    },
  });

  return result.toUIMessageStream({
    originalMessages: asOriginalMessages(messages),
    onError(error) {
      return error instanceof Error ? error.message : 'An error occurred.';
    },
  }) as ReadableStream<UIMessageChunk>;
}

async function onFinishHandler({
  result,
  tracer,
  chatInitialId,
  toolsDisabledFromRepeatedErrors,
  collapsedMessages,
  promptCharacterCounts,
  _startTime,
  _firstResponseTime,
  providerModel,
}: {
  result: any;
  tracer: Tracer | null;
  chatInitialId: string;
  toolsDisabledFromRepeatedErrors: boolean;
  collapsedMessages: boolean;
  promptCharacterCounts?: PromptCharacterCounts;
  _startTime: number;
  _firstResponseTime: number | null;
  providerModel: string;
}) {
  const { providerMetadata } = result;
  const finalUsage = result.totalUsage ?? result.usage;
  // This usage accumulates across multiple /api/chat calls until finishReason of 'stop'.
  const usage = {
    outputTokens: normalizeUsage(finalUsage.outputTokens),
    inputTokens: normalizeUsage(finalUsage.inputTokens),
    totalTokens: normalizeUsage(finalUsage.totalTokens),
  };
  logger.debug('Finished streaming', {
    finishReason: result.finishReason,
    usage,
    providerMetadata,
  });
  logger.debug('Prompt character counts', promptCharacterCounts);
  if (tracer) {
    const span = tracer.startSpan('on-finish-handler');
    span.setAttribute('chatInitialId', chatInitialId);
    span.setAttribute('finishReason', result.finishReason);
    span.setAttribute('usage.outputTokens', usage.outputTokens);
    span.setAttribute('usage.inputTokens', usage.inputTokens);
    span.setAttribute('usage.totalTokens', usage.totalTokens);
    span.setAttribute('collapsedMessages', collapsedMessages);
    span.setAttribute('model', providerModel);

    if (promptCharacterCounts) {
      span.setAttribute('promptCharacterCounts.messageHistoryChars', promptCharacterCounts.messageHistoryChars);
      span.setAttribute('promptCharacterCounts.currentTurnChars', promptCharacterCounts.currentTurnChars);
      span.setAttribute('promptCharacterCounts.totalPromptChars', promptCharacterCounts.totalPromptChars);
    }
    span.setAttribute('providerMetadata.cloudflare.cachedPromptTokens', cachedPromptTokens(providerMetadata));
    if (result.finishReason === 'stop' || result.finishReason === 'unknown') {
      span.setAttribute('tools.disabledFromRepeatedErrors', toolsDisabledFromRepeatedErrors ? 'true' : 'false');
    }
    span.end();
  }

  if (toolsDisabledFromRepeatedErrors) {
    logger.warn('Tools disabled because of repeated errors');
  }

  await new Promise((resolve) => setTimeout(resolve, 0));
}

function normalizeUsage(usage: number) {
  return Number.isNaN(usage) ? 0 : usage;
}
