import {
  runAgentLoopContinue,
  type AgentContext,
  type AgentEvent,
  type AgentLoopConfig,
  type AgentMessage,
} from '@earendil-works/pi-agent-core';
import type { Message } from '@earendil-works/pi-ai';
import type { PiStreamChunk } from './pi-stream';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { calculatePromptCharacterCounts } from 'ghostbuild-agent/context-message-metrics';
import { generalSystemPrompt, ROLE_SYSTEM_PROMPT } from 'ghostbuild-agent/prompts/system';

type UIMessageChunk = PiStreamChunk;

function createUIMessageStream(options: {
  originalMessages: unknown[];
  execute: (ctx: { writer: { write: (chunk: PiStreamChunk) => void } }) => void;
  onError: (error: unknown) => string;
}): ReadableStream<PiStreamChunk> {
  return new ReadableStream<PiStreamChunk>({
    start(controller) {
      const writer = { write: (chunk: PiStreamChunk) => controller.enqueue(chunk) };
      try {
        options.execute({ writer });
        controller.enqueue({ type: 'finish', finishReason: 'stop' } as PiStreamChunk);
      } catch (error) {
        controller.enqueue({ type: 'error', errorText: options.onError(error) } as PiStreamChunk);
      }
      controller.close();
    },
  });
}
import type { ChatTurnContext } from 'ghostbuild-agent/turn-context';
import { logger } from 'ghostbuild-agent/utils/logger';
import type { WorkersAiModelId } from '~/lib/workers-ai-model';
import type { BuilderWorkspaceApi } from '~/agents/builder-workspace-api';
import type { BuilderValidationStage } from '~/lib/common/builder-validation-progress';
import {
  BuilderTurnBudgetExceededError,
  builderTurnStepBudgetExceeded,
  classifyBuilderTimeout,
} from './builder-turn-budget';
import type { ContextCompaction } from './context-compaction';
import { prepareModelInput } from './model-input';
import { asOriginalMessages } from './message-conversion';
import { modelMessagesToPi } from './pi-message-conversion';
import { getPiProvider, type WorkersAiAccountCredentials } from './provider';
import { appendDeterministicCompletion, normalizeTextPartBoundaries } from './workers-ai-stream';
import { recordFirstWorkersAiResponse, recordWorkersAiFinish } from './workers-ai-telemetry';
import { getValidatedBuildCompletion, getWorkersAiToolSettings, type AgentToolChoice } from './workers-ai-tools';
import { createPiToolBundle, piToolsToList } from './pi-tools-adapter';
import { languageModelId } from 'ghostbuild-agent/ai-compat';
import {
  cloudflareAiFundingRequiredMessage,
  isCloudflareAiFundingError,
  isWorkersAiFreeAllocationError,
  workersPaidRequiredMessage,
} from '~/lib/workers-paid';
import { logProviderFailure } from './provider-error-logging';

type Messages = GhostbuildMessage[];

interface PiAgentOptions {
  env: Env;
  abortSignal?: AbortSignal;
  chatInitialId: string;
  firstUserMessage: boolean;
  messages: Messages;
  modelId: WorkersAiModelId;
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
  runWithKeepAlive: <T>(operation: () => Promise<T>) => Promise<T>;
}

// New Pi-backed implementation — mirrors cloudflare-os runAgent loop pattern
export async function piAgentRunner(options: PiAgentOptions): Promise<ReadableStream<UIMessageChunk>> {
  const {
    abortSignal,
    chatInitialId,
    firstUserMessage,
    messages,
    modelId,
    turnContext,
    compaction,
    accountCredentials,
    sessionAffinity,
    workspace,
    userId,
    agentName,
    onValidationStage,
    runWithKeepAlive,
  } = options;

  logger.debug('Starting Pi agent runner');
  const startedAt = Date.now();
  let recordedFirstResponse = false;

  const piProvider = getPiProvider(accountCredentials, modelId, { sessionAffinity });
  const { canonicalTools, piTools } = createPiToolBundle(workspace, {
    env: options.env,
    userId,
    agentName,
    chatInitialId,
    onValidationStage,
    runWithKeepAlive,
  });
  const piToolsList = piToolsToList(piTools);

  const validatedBuildCompletion = getValidatedBuildCompletion(messages);
  if (validatedBuildCompletion) {
    logger.info('Returning validated build completion without another model turn (pi)');
    return createValidatedBuildCompletionStream(messages, validatedBuildCompletion);
  }

  let toolSettings = getWorkersAiToolSettings(messages);
  const systemPrompts = [ROLE_SYSTEM_PROMPT, generalSystemPrompt()];
  const modelInput = await prepareModelInput({
    messages,
    turnContext,
    currentCompaction: compaction.current,
    compactionPending: compaction.pending,
    summarize: compaction.summarize,
    scheduleCompaction: compaction.schedule,
    systemPrompts,
    tools: canonicalTools,
    toolChoice: toolSettings.toolChoice,
    activeTools: toolSettings.activeTools,
    logger,
  });
  if (modelInput.nextCompaction) {
    compaction.save(modelInput.nextCompaction);
  }

  const promptCharacterCounts = calculatePromptCharacterCounts(modelInput.promptMessages, systemPrompts);
  const providerModel = languageModelId({ modelId } as unknown as { modelId: string }, modelId);

  const piMessages = modelMessagesToPi(modelInput.messages);

  // Bridge AgentEvent -> UIMessageChunk via a TransformStream. This keeps frontend on UIMessage
  // protocol during strangler, while LLM loop is fully Pi (runAgentLoopContinue).
  let currentValidatedBuildCompletion: string | undefined;
  const currentRunToolResults: Array<{ toolName: string; result: unknown }> = [];
  let stepCount = 0;

  const { readable, writable } = new TransformStream<UIMessageChunk, UIMessageChunk>();
  const writer = writable.getWriter();

  const emit = async (event: AgentEvent) => {
    if (event.type === 'message_update') {
      if (!recordedFirstResponse) {
        recordedFirstResponse = true;
        recordFirstWorkersAiResponse(startedAt);
      }
      const assistantEvent = event.assistantMessageEvent as unknown as Record<string, unknown>;
      const type = assistantEvent.type as string | undefined;
      const textPartId = `pi-${event.message?.timestamp ?? Date.now()}-${assistantEvent.contentIndex ?? 0}`;
      // Map AssistantMessageEvent to UIMessage text deltas
      if (type === 'text_start') {
        await writer.write({ type: 'text-start', id: textPartId });
      } else if (type === 'text_delta' && typeof assistantEvent.delta === 'string' && assistantEvent.delta) {
        await writer.write({ type: 'text-delta', id: textPartId, delta: assistantEvent.delta });
      } else if (type === 'text_end') {
        await writer.write({ type: 'text-end', id: textPartId });
      }
      if (type === 'thinking_delta') {
        // reasoning/thinking is not exposed as separate part in ghost-build UIMessage yet; ignore or map
      }
    } else if (event.type === 'tool_execution_start') {
      await writer.write({
        type: 'tool-input-start',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        dynamic: true,
      });
      await writer.write({
        type: 'tool-input-available',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.args,
        dynamic: true,
      });
    } else if (event.type === 'tool_execution_end') {
      const result = piToolResultDetails(event.result);
      currentRunToolResults.push({ toolName: event.toolName, result });
      await writer.write(
        event.isError
          ? {
              type: 'tool-output-error',
              toolCallId: event.toolCallId,
              errorText: piToolResultError(event.result),
              dynamic: true,
            }
          : {
              type: 'tool-output-available',
              toolCallId: event.toolCallId,
              output: result,
              dynamic: true,
            },
      );
      // Check validated build completion like streamText stopWhen did
      const completion = getValidatedBuildCompletion(messages, currentRunToolResults);
      if (completion) {
        currentValidatedBuildCompletion = completion;
      }
    } else if (event.type === 'turn_end') {
      stepCount += 1;
      if (currentValidatedBuildCompletion) {
        // Pi's shouldStopAfterTurn will handle, but we also track for telemetry
      } else if (builderTurnStepBudgetExceeded(stepCount, false)) {
        // surface as error chunk — pi loop will throw via shouldStop
      }
    } else if (event.type === 'agent_end') {
      // finish
    }
  };

  const context: AgentContext = {
    systemPrompt: systemPrompts.join('\n\n'),
    messages: piMessages as unknown as AgentMessage[],
    tools: selectPiTools(piToolsList, toolSettings),
  };

  // Run loop in background, writing chunks as events arrive
  (async () => {
    try {
      const loopConfig: AgentLoopConfig & { toolChoice: AgentToolChoice } = {
        model: piProvider.handle.model,
        convertToLlm: (msgs) => msgs as unknown as Message[],
        shouldStopAfterTurn: () => {
          // Mirror previous stopWhen: stop when validated build completion is achieved
          if (currentValidatedBuildCompletion) {
            return true;
          }
          // Also stop on turn budget
          if (builderTurnStepBudgetExceeded(stepCount, false)) {
            return true;
          }
          return false;
        },
        prepareNextTurn: ({ context: nextContext }) => {
          toolSettings = getWorkersAiToolSettings(messages, currentRunToolResults);
          nextContext.tools = selectPiTools(piToolsList, toolSettings);
          // Mutate the current context so the low-level loop retains the config getter below.
          return undefined;
        },
        maxTokens: piProvider.maxTokens,
        get toolChoice() {
          return toolSettings.toolChoice;
        },
        // Timeout via abortSignal + builder budget
      };
      await runAgentLoopContinue(context, loopConfig, emit, abortSignal, piProvider.handle.stream);

      // Handle budget exceeded as error
      if (builderTurnStepBudgetExceeded(stepCount, false) && !currentValidatedBuildCompletion) {
        await writer.write({
          type: 'error',
          errorText: new BuilderTurnBudgetExceededError('model_steps').message,
        } as unknown as UIMessageChunk);
      }

      recordWorkersAiFinish({
        result: {
          finishReason: currentValidatedBuildCompletion ? 'stop' : 'stop',
          totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        } as unknown as Parameters<typeof recordWorkersAiFinish>[0]['result'],
        firstUserMessage,
        contextReduced: modelInput.contextCompacted,
        estimatedContextTokens: modelInput.estimatedTokens,
        promptCharacterCounts,
        providerModel,
        promptCacheAttempted: true,
        startedAt,
      });
    } catch (error) {
      logProviderFailure(logger, 'Pi agent runner failed.', classifyBuilderTimeout(error) ?? (error as Error));
      const budgetError =
        error instanceof BuilderTurnBudgetExceededError ? error : classifyBuilderTimeout(error as Error);
      if (budgetError) {
        await writer.write({ type: 'error', errorText: budgetError.message } as unknown as UIMessageChunk);
      } else if (isWorkersAiFreeAllocationError(error)) {
        await writer.write({ type: 'error', errorText: workersPaidRequiredMessage() } as unknown as UIMessageChunk);
      } else if (isCloudflareAiFundingError(error)) {
        await writer.write({
          type: 'error',
          errorText: cloudflareAiFundingRequiredMessage(),
        } as unknown as UIMessageChunk);
      } else {
        await writer.write({
          type: 'error',
          errorText: error instanceof Error ? error.message : 'An error occurred.',
        } as unknown as UIMessageChunk);
      }
    } finally {
      try {
        await writer.close();
      } catch {}
    }
  })();

  // Wrap readable in UIMessageStream framing so frontend's useChat/useBuilderAgentChat still works
  const framedStream = new ReadableStream<UIMessageChunk>({
    async start(controller) {
      const reader = readable.getReader();
      // Emit start + originalMessages framing like toUIMessageStream does
      // Let the downstream normalize handle it; we inject a minimal start chunk
      controller.enqueue({ type: 'start' } as unknown as UIMessageChunk);
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          // Pass through pi->UIMessage deltas, plus inject deterministic completion at end
          controller.enqueue(value);
        }
        controller.enqueue({ type: 'finish', finishReason: 'stop' } as unknown as UIMessageChunk);
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });

  return normalizeTextPartBoundaries(
    appendDeterministicCompletion(framedStream, () => currentValidatedBuildCompletion),
  );
}

function selectPiTools(
  tools: AgentContext['tools'],
  settings: ReturnType<typeof getWorkersAiToolSettings>,
): AgentContext['tools'] {
  const availableTools = tools ?? [];
  if (settings.toolChoice === 'none') {
    return [];
  }
  if (!settings.activeTools) {
    return availableTools;
  }
  const activeToolNames = new Set<string>(settings.activeTools);
  return availableTools.filter((tool) => activeToolNames.has(tool.name));
}

function createValidatedBuildCompletionStream(messages: Messages, text: string): ReadableStream<UIMessageChunk> {
  return createUIMessageStream({
    originalMessages: asOriginalMessages(messages),
    execute: ({ writer }) => {
      const id = 'validated-build-completion';
      writer.write({ type: 'start' });
      writer.write({ type: 'text-start', id });
      writer.write({ type: 'text-delta', id, delta: text });
      writer.write({ type: 'text-end', id });
    },
    onError: (error) => (error instanceof Error ? error.message : 'An error occurred.'),
  }) as ReadableStream<UIMessageChunk>;
}

function piToolResultDetails(result: unknown): unknown {
  return isRecord(result) && 'details' in result ? result.details : result;
}

function piToolResultError(result: unknown): string {
  if (isRecord(result) && Array.isArray(result.content)) {
    const text = result.content.find(
      (block): block is { type: 'text'; text: string } =>
        isRecord(block) && block.type === 'text' && typeof block.text === 'string',
    )?.text;
    if (text) {
      return text;
    }
  }
  const details = piToolResultDetails(result);
  return isRecord(details) && typeof details.summary === 'string' ? details.summary : 'Tool execution failed.';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
