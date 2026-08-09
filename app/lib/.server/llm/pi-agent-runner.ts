import {
  runAgentLoopContinue,
  type AgentContext,
  type AgentEvent,
  type AgentLoopConfig,
  type AgentMessage,
} from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Message, Usage } from '@earendil-works/pi-ai';
import type { PiStreamChunk } from './pi-stream';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { calculatePromptCharacterCounts } from 'ghostbuild-agent/context-message-metrics';
import { generalSystemPrompt, ROLE_SYSTEM_PROMPT } from 'ghostbuild-agent/prompts/system';
import { toolResultSucceeded } from 'ghostbuild-agent/tool-result';
import type { ChatTurnContext } from 'ghostbuild-agent/turn-context';
import { logger } from 'ghostbuild-agent/utils/logger';
import type { WorkersAiModelId } from '~/lib/workers-ai-model';
import type { BuilderWorkspaceApi } from '~/agents/builder-workspace-api';
import type { BuilderValidationStage } from '~/lib/common/builder-validation-progress';
import {
  BUILDER_TURN_BUDGET_ERROR_CODE,
  BUILDER_TURN_MAX_MODEL_STEPS,
  BUILDER_TURN_TIMEOUTS,
  BuilderTurnBudgetExceededError,
  classifyBuilderTimeout,
} from './builder-turn-budget';
import type { ContextCompaction } from './context-compaction';
import { ContextCompactionUnavailableError, ModelInputBudgetExceededError, prepareModelInput } from './model-input';
import { modelMessagesToPi } from './pi-message-conversion';
import { recordPiStage } from './pi-telemetry';
import { getPiProvider, type WorkersAiAccountCredentials } from './provider';
import { appendDeterministicCompletion, normalizeTextPartBoundaries } from './workers-ai-stream';
import { recordFirstWorkersAiResponse, recordWorkersAiFinish } from './workers-ai-telemetry';
import { getValidatedBuildCompletion } from './workers-ai-tools';
import { createPiToolBundle, piToolsToList } from './pi-tools-adapter';
import {
  cloudflareAiFundingRequiredMessage,
  isCloudflareAiFundingError,
  isWorkersAiFreeAllocationError,
  workersPaidRequiredMessage,
} from '~/lib/workers-paid';
import { logProviderFailure } from './provider-error-logging';

type Messages = GhostbuildMessage[];
type UIMessageChunk = PiStreamChunk;

interface PiAgentOptions {
  abortSignal?: AbortSignal;
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
  onValidationStage?: (toolCallId: string, stage: BuilderValidationStage | null) => void;
  runWithKeepAlive: <T>(operation: () => Promise<T>) => Promise<T>;
}

type PiPreparationStage = 'tool_setup' | 'model_input' | 'prompt_metrics' | 'message_conversion';

class PiAgentPreparationError extends Error {
  readonly diagnosticCode: string;

  constructor(stage: PiPreparationStage, cause: unknown) {
    super(`Pi agent preparation failed during ${stage}.`, { cause });
    this.name = 'PiAgentPreparationError';
    this.diagnosticCode = `pi_prepare:${stage}`;
  }
}

export async function piAgentRunner(options: PiAgentOptions): Promise<ReadableStream<UIMessageChunk>> {
  const {
    abortSignal,
    firstUserMessage,
    messages,
    modelId,
    turnContext,
    compaction,
    accountCredentials,
    sessionAffinity,
    workspace,
    onValidationStage,
    runWithKeepAlive,
  } = options;

  logger.debug('Starting Pi agent runner');
  const startedAt = Date.now();
  const piProvider = getPiProvider(accountCredentials, modelId, { sessionAffinity });
  const { canonicalTools, piTools } = withPreparationStage('tool_setup', () =>
    createPiToolBundle(workspace, { onValidationStage, runWithKeepAlive }),
  );

  const validatedBuildCompletion = getValidatedBuildCompletion(messages);
  if (validatedBuildCompletion) {
    logger.info('Returning validated build completion without another model turn (pi)');
    return createValidatedBuildCompletionStream(validatedBuildCompletion);
  }

  const systemPrompts = [ROLE_SYSTEM_PROMPT, generalSystemPrompt()];
  const modelInput = await withPreparationStage('model_input', () =>
    prepareModelInput({
      messages,
      turnContext,
      currentCompaction: compaction.current,
      compactionPending: compaction.pending,
      summarize: compaction.summarize,
      scheduleCompaction: compaction.schedule,
      systemPrompts,
      tools: canonicalTools,
      logger,
    }),
  );
  if (modelInput.nextCompaction) {
    compaction.save(modelInput.nextCompaction);
  }

  const promptCharacterCounts = withPreparationStage('prompt_metrics', () =>
    calculatePromptCharacterCounts(modelInput.promptMessages, systemPrompts),
  );
  const piMessages = withPreparationStage('message_conversion', () => modelMessagesToPi(modelInput.messages));
  recordPiStage('prepared', modelId);

  let currentValidatedBuildCompletion: string | undefined;
  const currentRunToolResults: Array<{ toolName: string; result: unknown }> = [];
  const streamedToolCalls = new Map<number, { toolCallId: string; toolName: string }>();
  const completedToolInputs = new Set<string>();
  let recordedFirstResponse = false;
  let stepCount = 0;
  let stepBudgetStopped = false;
  let toolBudgetError: BuilderTurnBudgetExceededError | undefined;
  let terminalAssistant: AssistantMessage | undefined;
  let totalUsage = emptyUsage();

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
      const textPartId = `pi-${event.message.timestamp}-${assistantEvent.contentIndex ?? 0}`;
      if (type === 'text_start') {
        await writer.write({ type: 'text-start', id: textPartId });
      } else if (type === 'text_delta' && typeof assistantEvent.delta === 'string' && assistantEvent.delta) {
        await writer.write({ type: 'text-delta', id: textPartId, delta: assistantEvent.delta });
      } else if (type === 'text_end') {
        await writer.write({ type: 'text-end', id: textPartId });
      } else if (type === 'toolcall_start') {
        const streamed = streamedToolCall(assistantEvent);
        if (streamed) {
          streamedToolCalls.set(streamed.contentIndex, streamed);
          await writer.write({
            type: 'tool-input-start',
            toolCallId: streamed.toolCallId,
            toolName: streamed.toolName,
            dynamic: true,
          });
        }
      } else if (type === 'toolcall_delta' && typeof assistantEvent.delta === 'string') {
        const contentIndex = numericContentIndex(assistantEvent);
        const streamed = contentIndex === undefined ? undefined : streamedToolCalls.get(contentIndex);
        if (streamed) {
          await writer.write({
            type: 'tool-input-delta',
            toolCallId: streamed.toolCallId,
            inputTextDelta: assistantEvent.delta,
          });
        }
      } else if (type === 'toolcall_end') {
        const toolCall = recordValue(assistantEvent.toolCall);
        const toolCallId = typeof toolCall?.id === 'string' ? toolCall.id : undefined;
        const toolName = typeof toolCall?.name === 'string' ? toolCall.name : undefined;
        if (toolCall && toolCallId && toolName) {
          completedToolInputs.add(toolCallId);
          await writer.write({
            type: 'tool-input-available',
            toolCallId,
            toolName,
            input: toolCall.arguments,
            dynamic: true,
          });
        }
      }
      return;
    }

    if (event.type === 'tool_execution_start') {
      if (!completedToolInputs.has(event.toolCallId)) {
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
        completedToolInputs.add(event.toolCallId);
      }
      return;
    }

    if (event.type === 'tool_execution_update') {
      await writer.write({
        type: 'data-tool-progress',
        id: event.toolCallId,
        data: { toolCallId: event.toolCallId, toolName: event.toolName, result: event.partialResult },
        transient: true,
      });
      return;
    }

    if (event.type === 'tool_execution_end') {
      const result = piToolResultDetails(event.result);
      toolBudgetError ??= event.isError ? toolBudgetErrorFromResult(event.result) : undefined;
      currentRunToolResults.push({ toolName: event.toolName, result });
      if (event.isError && !hasStructuredToolResult(event.result)) {
        await writer.write({
          type: 'tool-output-error',
          toolCallId: event.toolCallId,
          errorText: piToolResultError(event.result),
          dynamic: true,
        });
      } else {
        await writer.write({
          type: 'tool-output-available',
          toolCallId: event.toolCallId,
          output: result,
          dynamic: true,
        });
      }
      currentValidatedBuildCompletion = getValidatedBuildCompletion(messages, currentRunToolResults);
      return;
    }

    if (event.type === 'turn_end') {
      stepCount += 1;
      if (isAssistantMessage(event.message)) {
        terminalAssistant = event.message;
        totalUsage = addUsage(totalUsage, event.message.usage);
      }
    }
  };

  const context: AgentContext = {
    systemPrompt: systemPrompts.join('\n\n'),
    messages: piMessages as unknown as AgentMessage[],
    tools: piToolsToList(piTools),
  };
  const totalTimeoutSignal = AbortSignal.timeout(BUILDER_TURN_TIMEOUTS.totalMs);
  const loopSignal = abortSignal ? AbortSignal.any([abortSignal, totalTimeoutSignal]) : totalTimeoutSignal;

  void (async () => {
    try {
      recordPiStage('loop_start', modelId);
      const loopConfig: AgentLoopConfig & { toolChoice: 'auto' } = {
        model: piProvider.handle.model,
        convertToLlm: (agentMessages) => agentMessages as unknown as Message[],
        shouldStopAfterTurn: ({ message }) => {
          const wouldContinue = isAssistantMessage(message) && message.content.some((part) => part.type === 'toolCall');
          stepBudgetStopped = stepCount >= BUILDER_TURN_MAX_MODEL_STEPS && wouldContinue;
          return toolBudgetError !== undefined || stepBudgetStopped;
        },
        afterToolCall: async ({ result, isError }) =>
          !isError && !toolResultSucceeded(result.details) ? { isError: true } : undefined,
        maxTokens: piProvider.maxTokens,
        timeoutMs: BUILDER_TURN_TIMEOUTS.modelStreamMs,
        toolChoice: 'auto',
      };
      await runAgentLoopContinue(context, loopConfig, emit, loopSignal, piProvider.handle.stream);
      recordPiStage('loop_complete', modelId);
      stepBudgetStopped ||=
        stepCount >= BUILDER_TURN_MAX_MODEL_STEPS &&
        terminalAssistant?.content.some((part) => part.type === 'toolCall') === true;

      if (totalTimeoutSignal.aborted && !abortSignal?.aborted) {
        throw new BuilderTurnBudgetExceededError('total_timeout');
      }
      if (toolBudgetError) {
        throw toolBudgetError;
      }
      if (terminalAssistant?.stopReason === 'error') {
        if (/time(?:d out|out)/i.test(terminalAssistant.errorMessage ?? '')) {
          throw new BuilderTurnBudgetExceededError('stream_stall');
        }
        throw new Error(terminalAssistant.errorMessage || 'The model request failed.');
      }
      if (terminalAssistant?.stopReason === 'aborted' && !abortSignal?.aborted) {
        throw new Error(terminalAssistant.errorMessage || 'The model request was aborted.');
      }
      if (stepBudgetStopped && !currentValidatedBuildCompletion) {
        await writer.write({
          type: 'error',
          errorText: new BuilderTurnBudgetExceededError('model_steps').message,
        });
      }

      recordWorkersAiFinish({
        usage: totalUsage,
        finishReason: stepBudgetStopped ? 'length' : (terminalAssistant?.stopReason ?? 'stop'),
        firstUserMessage,
        contextReduced: modelInput.contextCompacted,
        estimatedContextTokens: modelInput.estimatedTokens,
        promptCharacterCounts,
        providerModel: modelId,
        startedAt,
      });
    } catch (error) {
      recordPiStage('loop_error', modelId);
      const budgetError =
        error instanceof BuilderTurnBudgetExceededError ? error : classifyBuilderTimeout(error, 'total_timeout');
      logProviderFailure(logger, 'Pi agent runner failed.', budgetError ?? error);
      if (budgetError) {
        await writer.write({ type: 'error', errorText: budgetError.message });
      } else if (isWorkersAiFreeAllocationError(error)) {
        await writer.write({ type: 'error', errorText: workersPaidRequiredMessage() });
      } else if (isCloudflareAiFundingError(error)) {
        await writer.write({ type: 'error', errorText: cloudflareAiFundingRequiredMessage() });
      } else if (!abortSignal?.aborted) {
        await writer.write({ type: 'error', errorText: 'The model request failed. Please retry.' });
      }
    } finally {
      await writer.close().catch(() => undefined);
    }
  })();

  const framedStream = new ReadableStream<UIMessageChunk>({
    async start(controller) {
      const reader = readable.getReader();
      controller.enqueue({ type: 'start' });
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          controller.enqueue(value);
        }
        controller.enqueue({
          type: 'finish',
          finishReason: stepBudgetStopped || terminalAssistant?.stopReason === 'length' ? 'length' : 'stop',
        });
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
  });

  return normalizeTextPartBoundaries(
    appendDeterministicCompletion(framedStream, () => currentValidatedBuildCompletion),
  );
}

function createValidatedBuildCompletionStream(text: string): ReadableStream<UIMessageChunk> {
  return new ReadableStream({
    start(controller) {
      const id = 'validated-build-completion';
      controller.enqueue({ type: 'start' });
      controller.enqueue({ type: 'text-start', id });
      controller.enqueue({ type: 'text-delta', id, delta: text });
      controller.enqueue({ type: 'text-end', id });
      controller.enqueue({ type: 'finish', finishReason: 'stop' });
      controller.close();
    },
  });
}

function piToolResultDetails(result: unknown): unknown {
  return isRecord(result) && 'details' in result ? result.details : result;
}

function hasStructuredToolResult(result: unknown): boolean {
  const details = piToolResultDetails(result);
  return isRecord(details) && Object.keys(details).length > 0;
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

function toolBudgetErrorFromResult(result: unknown): BuilderTurnBudgetExceededError | undefined {
  if (!isRecord(result) || !Array.isArray(result.content)) {
    return undefined;
  }
  const text = result.content.find(
    (block): block is { type: 'text'; text: string } =>
      isRecord(block) && block.type === 'text' && typeof block.text === 'string',
  )?.text;
  if (!text) {
    return undefined;
  }
  try {
    const payload = JSON.parse(text) as { code?: unknown; reason?: unknown };
    return payload.code === BUILDER_TURN_BUDGET_ERROR_CODE && payload.reason === 'tool_timeout'
      ? new BuilderTurnBudgetExceededError('tool_timeout')
      : undefined;
  } catch {
    return undefined;
  }
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return message.role === 'assistant';
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function addUsage(total: Usage, usage: Usage): Usage {
  return {
    input: total.input + usage.input,
    output: total.output + usage.output,
    cacheRead: total.cacheRead + usage.cacheRead,
    cacheWrite: total.cacheWrite + usage.cacheWrite,
    totalTokens: total.totalTokens + usage.totalTokens,
    cost: {
      input: total.cost.input + usage.cost.input,
      output: total.cost.output + usage.cost.output,
      cacheRead: total.cost.cacheRead + usage.cost.cacheRead,
      cacheWrite: total.cost.cacheWrite + usage.cost.cacheWrite,
      total: total.cost.total + usage.cost.total,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function numericContentIndex(value: Record<string, unknown>): number | undefined {
  return typeof value.contentIndex === 'number' && Number.isInteger(value.contentIndex)
    ? value.contentIndex
    : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function streamedToolCall(
  event: Record<string, unknown>,
): { contentIndex: number; toolCallId: string; toolName: string } | undefined {
  const contentIndex = numericContentIndex(event);
  const partial = recordValue(event.partial);
  const content = Array.isArray(partial?.content) ? partial.content : [];
  const call = contentIndex === undefined ? undefined : recordValue(content[contentIndex]);
  if (contentIndex === undefined || typeof call?.id !== 'string' || typeof call.name !== 'string') {
    return undefined;
  }
  return { contentIndex, toolCallId: call.id, toolName: call.name };
}

function withPreparationStage<T>(stage: PiPreparationStage, operation: () => Promise<T>): Promise<T>;
function withPreparationStage<T>(stage: PiPreparationStage, operation: () => T): T;
function withPreparationStage<T>(stage: PiPreparationStage, operation: () => T | Promise<T>): T | Promise<T> {
  try {
    const result = operation();
    return result instanceof Promise ? result.catch((error: unknown) => rethrowPreparationError(stage, error)) : result;
  } catch (error) {
    return rethrowPreparationError(stage, error);
  }
}

function rethrowPreparationError(stage: PiPreparationStage, error: unknown): never {
  if (error instanceof ModelInputBudgetExceededError || error instanceof ContextCompactionUnavailableError) {
    throw error;
  }
  throw new PiAgentPreparationError(stage, error);
}
