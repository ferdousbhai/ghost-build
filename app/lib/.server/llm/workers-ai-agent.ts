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
import { appendDeterministicCompletion, normalizeTextPartBoundaries } from './workers-ai-stream';
import { recordFirstWorkersAiResponse, recordWorkersAiFinish } from './workers-ai-telemetry';
import {
  createWorkersAiTools,
  getValidatedBuildCompletion,
  getWorkersAiToolSettings,
  serializeWorkersAiToolDefinitions,
} from './workers-ai-tools';
import { isWorkersAiFreeAllocationError, workersPaidRequiredMessage } from '~/lib/workers-paid';
import { fingerprintWorkersAiModelInput } from './workers-ai-prompt-cache';
import { logProviderFailure } from './provider-error-logging';
import type { BuilderWorkspaceRepository } from '~/agents/builder-workspace';

type Messages = GhostbuildMessage[];
// Server-owned validation can legitimately span the bounded production build
// pipeline (install, typecheck, stack verification, build, and lint).
const WORKERS_AI_CALL_TIMEOUT_MS = 10 * 60 * 60_000;
// Give the model a bounded implementation window before requiring validation.
// The overall turn is bounded by WORKERS_AI_CALL_TIMEOUT_MS rather than an
// arbitrary tool-step count so legitimate validation repair loops can finish.
const IMPLEMENTATION_TOOL_STEP_BUDGET = 7;

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
  workspace: BuilderWorkspaceRepository;
  userId: string;
  agentName: string;
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
  } = options;
  logger.debug('Starting Workers AI agent');
  const startedAt = Date.now();
  let recordedFirstResponse = false;
  const provider = getProvider(env, accountCredentials, CLOUDFLARE_WORKERS_AI_MODEL, { sessionAffinity });
  const tools = createWorkersAiTools(workspace, {
    env,
    userId,
    agentName,
    chatInitialId,
  });
  const validatedBuildCompletion = getValidatedBuildCompletion(messages);
  if (validatedBuildCompletion) {
    logger.info('Returning validated build completion without another model turn', { chatInitialId });
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
  const serializedTools = serializeWorkersAiToolDefinitions(tools, toolSettings.activeTools);
  const modelInputFingerprint = await fingerprintWorkersAiModelInput({
    privacySalt: sessionAffinity,
    model: providerModel,
    messages: modelInput.messages,
    tools: serializedTools,
    activeTools: toolSettings.activeTools,
    toolChoice: toolSettings.toolChoice,
  });
  let currentValidatedBuildCompletion: string | undefined;
  const result = streamText({
    model: provider.model,
    abortSignal,
    timeout: WORKERS_AI_CALL_TIMEOUT_MS,
    maxOutputTokens: provider.maxTokens,
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
        stepNumber >= IMPLEMENTATION_TOOL_STEP_BUDGET,
      );
      return {
        activeTools: nextSettings.activeTools,
        toolChoice: nextSettings.toolChoice,
      };
    },
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

  const stream = result.toUIMessageStream({
    originalMessages: asOriginalMessages(messages),
    onError: (error) => {
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
