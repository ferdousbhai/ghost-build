import { createUIMessageStream, streamText, toUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';
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
import { appendDeterministicCompletion, normalizeTextPartBoundaries } from './workers-ai-stream';
import { recordFirstWorkersAiResponse, recordWorkersAiFinish } from './workers-ai-telemetry';
import { createWorkersAiTools, getValidatedBuildCompletion, getWorkersAiToolSettings } from './workers-ai-tools';
import { isWorkersAiFreeAllocationError, workersPaidRequiredMessage } from '~/lib/workers-paid';
import { logProviderFailure } from './provider-error-logging';
import type { BuilderWorkspaceApi } from '~/agents/builder-workspace-api';
import type { BuilderValidationStage } from '~/lib/common/builder-validation-progress';
import {
  BUILDER_TURN_TIMEOUTS,
  BuilderTurnBudgetExceededError,
  builderTurnStepBudgetExceeded,
  classifyBuilderTimeout,
} from './builder-turn-budget';

type Messages = GhostbuildMessage[];
interface WorkersAiAgentOptions {
  env: Env;
  abortSignal?: AbortSignal;
  chatInitialId: string;
  firstUserMessage: boolean;
  messages: Messages;
  turnContext?: ChatTurnContext;
  compaction: {
    current: ContextCompaction | null;
    pending: boolean;
    summarize: (prompt: string) => Promise<string>;
    save: (compaction: ContextCompaction) => void;
    schedule?: () => Promise<void>;
  };
  accountCredentials: WorkersAiAccountCredentials;
  sessionAffinity: string;
  workspace: BuilderWorkspaceApi;
  userId: string;
  agentName: string;
  onValidationStage?: (toolCallId: string, stage: BuilderValidationStage | null) => void;
}

export async function workersAiAgent(options: WorkersAiAgentOptions): Promise<ReadableStream<UIMessageChunk>> {
  const {
    env,
    abortSignal,
    chatInitialId,
    firstUserMessage,
    messages,
    turnContext,
    compaction,
    accountCredentials,
    sessionAffinity,
    workspace,
    userId,
    agentName,
    onValidationStage,
  } = options;
  logger.debug('Starting Workers AI agent');
  const startedAt = Date.now();
  let recordedFirstResponse = false;
  const provider = getProvider(env, accountCredentials, CLOUDFLARE_WORKERS_AI_MODEL, {
    sessionAffinity,
    feature: 'builder-chat',
  });
  const tools = createWorkersAiTools(workspace, {
    env,
    userId,
    agentName,
    chatInitialId,
    onValidationStage,
  });
  const validatedBuildCompletion = getValidatedBuildCompletion(messages);
  if (validatedBuildCompletion) {
    logger.info('Returning validated build completion without another model turn');
    return createValidatedBuildCompletionStream(messages, validatedBuildCompletion);
  }

  const toolSettings = getWorkersAiToolSettings(messages);
  const systemPrompts = [ROLE_SYSTEM_PROMPT, generalSystemPrompt()];
  const modelInput = await prepareModelInput({
    messages,
    turnContext,
    currentCompaction: compaction.current,
    compactionPending: compaction.pending,
    summarize: compaction.summarize,
    scheduleCompaction: compaction.schedule,
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
  let currentValidatedBuildCompletion: string | undefined;
  const result = streamText({
    model: provider.model,
    abortSignal,
    timeout: BUILDER_TURN_TIMEOUTS,
    maxOutputTokens: provider.maxTokens,
    instructions: systemPrompts.join('\n\n'),
    messages: modelInput.messages,
    tools: asAiSdkTools(tools),
    toolChoice: toolSettings.toolChoice,
    activeTools: toolSettings.activeTools,
    stopWhen: ({ steps }) => {
      const completion = getValidatedBuildCompletion(
        messages,
        steps.flatMap(({ toolResults }) =>
          toolResults.map(({ toolName, output }) => ({
            toolName,
            result: output,
          })),
        ),
      );
      if (!completion) {
        if (builderTurnStepBudgetExceeded(steps.length, false)) {
          throw new BuilderTurnBudgetExceededError('model_steps');
        }
        return false;
      }
      currentValidatedBuildCompletion = completion;
      return true;
    },
    prepareStep: ({ stepNumber, steps }) => {
      if (stepNumber === 0) {
        return undefined;
      }
      const nextSettings = getWorkersAiToolSettings(
        messages,
        steps.flatMap(({ toolResults }) =>
          toolResults.map(({ toolName, output }) => ({
            toolName,
            result: output,
          })),
        ),
      );
      return {
        activeTools: nextSettings.activeTools,
        toolChoice: nextSettings.toolChoice,
      };
    },
    onChunk: () => {
      if (!recordedFirstResponse) {
        recordedFirstResponse = true;
        recordFirstWorkersAiResponse(startedAt);
      }
    },
    onEnd: (finishResult) => {
      recordWorkersAiFinish({
        result: finishResult,
        firstUserMessage,
        contextReduced: modelInput.contextCompacted,
        estimatedContextTokens: modelInput.estimatedTokens,
        promptCharacterCounts,
        providerModel,
        promptCacheAttempted: true,
        startedAt,
      });
    },
    onError: ({ error }) => {
      logProviderFailure(logger, 'Workers AI request failed.', classifyBuilderTimeout(error) ?? error);
    },
  });

  const stream = toUIMessageStream({
    stream: result.stream,
    originalMessages: asOriginalMessages(messages),
    onError: (error) => {
      const budgetError = error instanceof BuilderTurnBudgetExceededError ? error : classifyBuilderTimeout(error);
      if (budgetError) {
        return budgetError.message;
      }
      if (isWorkersAiFreeAllocationError(error)) {
        return workersPaidRequiredMessage();
      }
      return error instanceof Error ? error.message : 'An error occurred.';
    },
  }) as ReadableStream<UIMessageChunk>;
  return normalizeTextPartBoundaries(appendDeterministicCompletion(stream, () => currentValidatedBuildCompletion));
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
