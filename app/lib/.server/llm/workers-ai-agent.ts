import { createUIMessageStream, streamText, type UIMessage, type UIMessageChunk } from 'ai';
import { languageModelId, type GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { calculatePromptCharacterCounts } from 'ghostbuild-agent/context-message-metrics';
import { ROLE_SYSTEM_PROMPT, generalSystemPrompt } from 'ghostbuild-agent/prompts/system';
import type { ChatTurnContext } from 'ghostbuild-agent/turn-context';
import { logger } from 'ghostbuild-agent/utils/logger';
import { CLOUDFLARE_WORKERS_AI_MODEL } from '~/lib/workers-ai-model';
import { asAiSdkTools, asOriginalMessages } from './message-conversion';
import { getProvider, type WorkersAiAccountCredentials } from './provider';
import { prepareModelInput } from './model-input';
import type { ContextCompaction } from './context-compaction';
import { normalizeTextPartBoundaries } from './workers-ai-stream';
import { recordFirstWorkersAiResponse, recordWorkersAiFinish } from './workers-ai-telemetry';
import {
  createWorkersAiTools,
  getValidatedBuildCompletion,
  getWorkersAiBuildGuidance,
  getWorkersAiToolSettings,
  serializeWorkersAiToolDefinitions,
  type AgentToolSettings,
} from './workers-ai-tools';
import { isWorkersAiFreeAllocationError, workersPaidRequiredMessage } from '~/lib/workers-paid';
import { fingerprintWorkersAiModelInput } from './workers-ai-prompt-cache';
import { logProviderFailure } from './provider-error-logging';

type Messages = GhostbuildMessage[];
const WORKERS_AI_CALL_TIMEOUT_MS = 180_000;

interface WorkersAiAgentOptions {
  env: Env;
  abortSignal?: AbortSignal;
  chatInitialId: string;
  firstUserMessage: boolean;
  messages: Messages;
  turnContext?: ChatTurnContext;
  shouldDisableTools: boolean;
  compaction: {
    current: ContextCompaction | null;
    summarize: (prompt: string) => Promise<string>;
    save: (compaction: ContextCompaction) => void;
  };
  accountCredentials: WorkersAiAccountCredentials;
  sessionAffinity: string;
}

export async function workersAiAgent(options: WorkersAiAgentOptions): Promise<ReadableStream<UIMessageChunk>> {
  const {
    env,
    abortSignal,
    chatInitialId,
    firstUserMessage,
    messages,
    turnContext,
    shouldDisableTools,
    compaction,
    accountCredentials,
    sessionAffinity,
  } = options;
  logger.debug('Starting Workers AI agent');
  const startedAt = Date.now();
  let recordedFirstResponse = false;
  const provider = getProvider(env, accountCredentials, CLOUDFLARE_WORKERS_AI_MODEL, { sessionAffinity });
  const tools = createWorkersAiTools();
  const validatedBuildCompletion = shouldDisableTools ? undefined : getValidatedBuildCompletion(messages);
  if (validatedBuildCompletion) {
    logger.info('Returning validated build completion without another model turn', { chatInitialId });
    return createValidatedBuildCompletionStream(messages, validatedBuildCompletion);
  }

  const toolSettings: AgentToolSettings = shouldDisableTools
    ? { toolChoice: 'none' }
    : getWorkersAiToolSettings(messages);
  const buildGuidance = getWorkersAiBuildGuidance(messages);
  const systemPrompts = [ROLE_SYSTEM_PROMPT, generalSystemPrompt(), buildGuidance].filter((prompt): prompt is string =>
    Boolean(prompt),
  );
  const modelInput = await prepareModelInput({
    messages,
    turnContext,
    currentCompaction: compaction.current,
    summarize: compaction.summarize,
    systemPrompts,
    tools,
    toolChoice: toolSettings.toolChoice,
    activeTools: toolSettings.activeTools,
    logger,
  });
  if (modelInput.nextCompaction) {
    compaction.save(modelInput.nextCompaction);
  }
  const promptCharacterCounts = calculatePromptCharacterCounts(modelInput.promptMessages, systemPrompts);
  const providerModel = languageModelId(provider.model, CLOUDFLARE_WORKERS_AI_MODEL);
  const serializedTools = serializeWorkersAiToolDefinitions(tools, toolSettings.activeTools);
  const modelInputFingerprint = await fingerprintWorkersAiModelInput({
    privacySalt: sessionAffinity,
    model: providerModel,
    messages: modelInput.messages,
    tools: serializedTools,
    activeTools: toolSettings.activeTools,
    toolChoice: toolSettings.toolChoice,
  });
  let result;
  try {
    result = streamText({
      model: provider.model,
      abortSignal,
      timeout: WORKERS_AI_CALL_TIMEOUT_MS,
      maxOutputTokens: provider.maxTokens,
      messages: modelInput.messages,
      tools: asAiSdkTools(tools),
      toolChoice: toolSettings.toolChoice,
      activeTools: toolSettings.activeTools,
      onChunk: () => {
        if (!recordedFirstResponse) {
          recordedFirstResponse = true;
          recordFirstWorkersAiResponse(chatInitialId, startedAt);
        }
      },
      onFinish: (finishResult) => {
        recordWorkersAiFinish({
          result: finishResult,
          chatInitialId,
          firstUserMessage,
          toolsDisabledFromRepeatedErrors: shouldDisableTools,
          contextReduced: modelInput.contextCompacted,
          estimatedContextTokens: modelInput.estimatedTokens,
          promptCharacterCounts,
          providerModel,
          promptCacheAttempted: true,
          modelInputFingerprint,
          startedAt,
        });
      },
      onError: ({ error }) => {
        logProviderFailure(logger, 'Workers AI request failed.', error);
      },
    });
  } catch (error) {
    throw error;
  }

  const stream = result.toUIMessageStream({
    originalMessages: asOriginalMessages(messages),
    onError: (error) => {
      if (isWorkersAiFreeAllocationError(error)) {
        return workersPaidRequiredMessage();
      }
      return error instanceof Error ? error.message : 'An error occurred.';
    },
  }) as ReadableStream<UIMessageChunk>;
  return normalizeTextPartBoundaries(stream);
}

function createValidatedBuildCompletionStream(messages: Messages, text: string): ReadableStream<UIMessageChunk> {
  return createUIMessageStream<UIMessage>({
    originalMessages: asOriginalMessages(messages),
    execute: ({ writer }) => {
      const id = 'validated-build-completion';
      writer.write({ type: 'start' });
      writer.write({ type: 'text-start', id });
      writer.write({ type: 'text-delta', id, delta: text });
      writer.write({ type: 'text-end', id });
      writer.write({ type: 'finish', finishReason: 'stop' });
    },
    onError: (error) => (error instanceof Error ? error.message : 'An error occurred.'),
  }) as ReadableStream<UIMessageChunk>;
}
