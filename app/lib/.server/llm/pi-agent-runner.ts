import {
  runAgentLoopContinue,
  type AgentContext,
  type AgentEvent,
  type AgentLoopConfig,
  type AgentMessage,
} from '@earendil-works/pi-agent-core';
import {
  isContextOverflow,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Message,
  type Usage,
} from '@earendil-works/pi-ai';
import type { PiStreamChunk } from './pi-stream';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { calculatePromptCharacterCounts } from 'ghostbuild-agent/context-message-metrics';
import { systemPrompt } from 'ghostbuild-agent/prompts/system';
import { toolResultSucceeded } from 'ghostbuild-agent/tool-result';
import type { ChatTurnContext } from 'ghostbuild-agent/turn-context';
import { logger } from 'ghostbuild-agent/utils/logger';
import type { WorkersAiModelId } from '~/lib/workers-ai-model';
import {
  WORKSPACE_TOOL_OPERATION_INDETERMINATE_CODE,
  WorkspaceToolOperationIndeterminateError,
  type BuilderWorkspaceApi,
} from '~/agents/builder-workspace-api';
import type { BuilderValidationStage } from '~/lib/common/builder-validation-progress';
import {
  BUILDER_TURN_BUDGET_ERROR_CODE,
  BUILDER_TURN_INACTIVITY_MS,
  BUILDER_TURN_MAX_MODEL_STEPS,
  BUILDER_TURN_WALL_CLOCK_MS,
  BuilderTurnBudgetExceededError,
  type BuilderTurnBudgetReason,
  type BuilderTurnBudgetReport,
  type BuilderTurnTerminalReason,
} from './builder-turn-budget';
import { compactPiContext, estimatePiContextTokens, type ContextCompaction } from './context-compaction';
import {
  ContextCompactionUnavailableError,
  ModelInputBudgetExceededError,
  modelCompactionPolicy,
  prepareModelInput,
} from './model-input';
import { modelMessagesToPi } from './pi-message-conversion';
import { recordPiStage, recordPiTurnBudget } from './pi-telemetry';
import { getPiProvider, type WorkersAiAccountCredentials } from './provider';
import { appendDeterministicCompletion, normalizeTextPartBoundaries } from './workers-ai-stream';
import { recordFirstWorkersAiResponse, recordWorkersAiFinish } from './workers-ai-telemetry';
import { getValidatedBuildCompletion } from './workers-ai-tools';
import { createPiToolBundle, piToolsToList } from './pi-tools-adapter';
import { createBuilderSkillContext } from './builder-skills';
import {
  cloudflareAiFundingRequiredMessage,
  isCloudflareAiFundingError,
  isWorkersAiFreeAllocationError,
  workersPaidRequiredMessage,
} from '~/lib/workers-paid';
import { logProviderFailure } from './provider-error-logging';
import type { PiSteeringQueue } from './pi-steering';

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
    summarize: (prompt: string, signal?: AbortSignal) => Promise<string>;
    save: (compaction: ContextCompaction) => void;
    schedule?: () => Promise<void>;
    requestDurableCompaction?: () => void;
  };
  accountCredentials: WorkersAiAccountCredentials;
  sessionAffinity: string;
  workspace: BuilderWorkspaceApi;
  onValidationStage?: (toolCallId: string, stage: BuilderValidationStage | null) => void;
  runWithKeepAlive: <T>(operation: () => Promise<T>) => Promise<T>;
  steering: PiSteeringQueue;
  onSettled: (budget: BuilderTurnBudgetReport) => void;
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
    steering,
    onSettled,
  } = options;

  logger.debug('Starting Pi agent runner');
  const startedAt = Date.now();
  const piProvider = getPiProvider(accountCredentials, modelId, { sessionAffinity });
  // Real signals, so an in-flight model stream is bounded too — not just the gaps between turns.
  const wallClockSignal = AbortSignal.timeout(BUILDER_TURN_WALL_CLOCK_MS);
  const inactivityController = new AbortController();
  const loopSignal = AbortSignal.any(
    abortSignal
      ? [abortSignal, wallClockSignal, inactivityController.signal]
      : [wallClockSignal, inactivityController.signal],
  );
  /** Budget exhaustion stays distinct from an owner cancellation or a durable teardown. */
  const exhaustedBudgetReason = (): BuilderTurnBudgetReason | undefined => {
    if (abortSignal?.aborted) {
      return undefined;
    }
    return inactivityController.signal.aborted ? 'inactivity' : wallClockSignal.aborted ? 'wall_clock' : undefined;
  };
  const budgetErrorForFailure = (error: unknown): unknown => {
    const reason = error instanceof BuilderTurnBudgetExceededError ? undefined : exhaustedBudgetReason();
    return reason ? new BuilderTurnBudgetExceededError(reason) : error;
  };
  const compactionPolicy = modelCompactionPolicy(piProvider.handle.model.contextWindow);
  const { skillContext, piTools } = await withPreparationStage('tool_setup', async () => {
    const skillContext = createBuilderSkillContext();
    return {
      skillContext,
      piTools: createPiToolBundle(workspace, { onValidationStage, runWithKeepAlive }, skillContext.reader),
    };
  });

  const validatedBuildCompletion = getValidatedBuildCompletion(messages);
  if (validatedBuildCompletion && !steering.hasPending()) {
    logger.info('Returning validated build completion without another model turn (pi)');
    steering.close();
    onSettled({
      terminalReason: 'completed',
      stepCount: 0,
      toolCallCount: 0,
      elapsedMs: Date.now() - startedAt,
      lastValidationState: 'validated',
    });
    return createValidatedBuildCompletionStream(validatedBuildCompletion);
  }

  const instructions = systemPrompt(skillContext.prompt);
  const modelInput = await withPreparationStage('model_input', () =>
    prepareModelInput({
      messages,
      turnContext,
      currentCompaction: compaction.current,
      compactionPending: compaction.pending,
      summarize: compaction.summarize,
      scheduleCompaction: compaction.schedule,
      signal: loopSignal,
      contextWindow: piProvider.handle.model.contextWindow,
      systemPrompt: instructions,
      tools: piToolsToList(piTools),
      logger,
    }),
  );
  if (modelInput.nextCompaction) {
    compaction.save(modelInput.nextCompaction);
  }

  const promptCharacterCounts = withPreparationStage('prompt_metrics', () =>
    calculatePromptCharacterCounts(modelInput.promptMessages, instructions),
  );
  const piMessages = withPreparationStage('message_conversion', () => modelMessagesToPi(modelInput.messages));
  recordPiStage('prepared', modelId);

  let currentValidatedBuildCompletion: string | undefined;
  const currentRunToolResults: Array<{ toolName: string; result: unknown }> = [];
  const streamedToolCalls = new Map<number, { toolCallId: string; toolName: string }>();
  const completedToolInputs = new Set<string>();
  let recordedFirstResponse = false;
  let terminalAssistant: AssistantMessage | undefined;
  let totalUsage = emptyUsage();
  let currentTurnStreamedContent = false;
  let runtimeContextCompacted = false;
  let runtimeCompactionError: ContextCompactionUnavailableError | undefined;
  let toolBudgetError: BuilderTurnBudgetExceededError | undefined;
  let stepBudgetError: BuilderTurnBudgetExceededError | undefined;
  let toolIndeterminateError: WorkspaceToolOperationIndeterminateError | undefined;
  let terminalReason: BuilderTurnTerminalReason = 'failed';
  let stepCount = 0;
  let toolCallCount = 0;
  let toolsInFlight = 0;
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;

  const clearInactivityWatchdog = () => {
    clearTimeout(inactivityTimer);
    inactivityTimer = undefined;
  };
  /** Tools already carry their own deadlines, so only watch the gaps between them. */
  const armInactivityWatchdog = () => {
    clearInactivityWatchdog();
    if (toolsInFlight === 0) {
      inactivityTimer = setTimeout(() => inactivityController.abort(), BUILDER_TURN_INACTIVITY_MS);
    }
  };

  const { readable, writable } = new TransformStream<UIMessageChunk, UIMessageChunk>();
  const writer = writable.getWriter();

  const emit = async (event: AgentEvent) => {
    if (event.type === 'tool_execution_start') {
      toolsInFlight += 1;
    } else if (event.type === 'tool_execution_end') {
      toolsInFlight = Math.max(0, toolsInFlight - 1);
      toolCallCount += 1;
    } else if (event.type === 'turn_end') {
      toolsInFlight = 0;
    }
    armInactivityWatchdog();

    if (event.type === 'turn_start') {
      currentTurnStreamedContent = false;
      return;
    }

    if (event.type === 'message_update') {
      if (!recordedFirstResponse) {
        recordedFirstResponse = true;
        recordFirstWorkersAiResponse(startedAt);
      }
      const assistantEvent = event.assistantMessageEvent;
      currentTurnStreamedContent ||=
        assistantEvent.type === 'text_start' ||
        assistantEvent.type === 'text_delta' ||
        assistantEvent.type === 'toolcall_start' ||
        assistantEvent.type === 'toolcall_delta' ||
        assistantEvent.type === 'toolcall_end';
      const textPartId = `pi-${event.message.timestamp}-${eventContentIndex(assistantEvent) ?? 0}`;
      if (assistantEvent.type === 'text_start') {
        await writer.write({ type: 'text-start', id: textPartId });
      } else if (assistantEvent.type === 'text_delta' && assistantEvent.delta) {
        await writer.write({ type: 'text-delta', id: textPartId, delta: assistantEvent.delta });
      } else if (assistantEvent.type === 'text_end') {
        await writer.write({ type: 'text-end', id: textPartId });
      } else if (assistantEvent.type === 'toolcall_start') {
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
      } else if (assistantEvent.type === 'toolcall_delta') {
        const streamed = streamedToolCalls.get(assistantEvent.contentIndex);
        if (streamed) {
          await writer.write({
            type: 'tool-input-delta',
            toolCallId: streamed.toolCallId,
            inputTextDelta: assistantEvent.delta,
          });
        }
      } else if (assistantEvent.type === 'toolcall_end') {
        const { toolCall } = assistantEvent;
        if (toolCall.id && toolCall.name) {
          completedToolInputs.add(toolCall.id);
          await writer.write({
            type: 'tool-input-available',
            toolCallId: toolCall.id,
            toolName: toolCall.name,
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
      toolIndeterminateError ??= event.isError ? toolIndeterminateErrorFromResult(event.result) : undefined;
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

  let context: AgentContext = {
    systemPrompt: instructions,
    messages: piMessages,
    tools: piToolsToList(piTools),
  };

  const compactRuntimeContext = async (source: AgentContext): Promise<AgentContext | undefined> => {
    try {
      const compacted = await compactPiContext({
        messages: source.messages,
        summarize: compaction.summarize,
        signal: loopSignal,
      });
      if (!compacted) {
        runtimeCompactionError = new ContextCompactionUnavailableError(
          new Error('The active turn has no safe compaction boundary.'),
        );
        return undefined;
      }
      runtimeContextCompacted = true;
      compaction.requestDurableCompaction?.();
      logger.info('Compacted live Pi context', {
        tokensBefore: compacted.tokensBefore,
        tokensAfter: compacted.tokensAfter,
      });
      return { ...source, messages: compacted.messages };
    } catch (error) {
      loopSignal?.throwIfAborted();
      runtimeCompactionError =
        error instanceof ContextCompactionUnavailableError ? error : new ContextCompactionUnavailableError(error);
      return undefined;
    }
  };

  void (async () => {
    try {
      recordPiStage('loop_start', modelId);
      const loopConfig: AgentLoopConfig & { toolChoice: 'auto' } = {
        model: piProvider.handle.model,
        // SAFETY: every message in this loop's context originates from `modelMessagesToPi`, the Pi
        // tool adapter, or the Pi stream itself, so the context never holds a custom agent message.
        convertToLlm: (agentMessages) => agentMessages as Message[],
        getSteeringMessages: async () => {
          const messages = await steering.drain();
          if (messages.length > 0) {
            currentValidatedBuildCompletion = undefined;
          }
          return messages;
        },
        prepareNextTurn: async ({ message, context: turnContext }) => {
          const wouldContinue = message.content.some((part) => part.type === 'toolCall');
          if (!wouldContinue || estimatePiContextTokens(turnContext.messages) < compactionPolicy.hardLimitTokens) {
            return undefined;
          }
          const compacted = await compactRuntimeContext(turnContext);
          if (!compacted) {
            return undefined;
          }
          context = compacted;
          return { context: compacted };
        },
        shouldStopAfterTurn: () => {
          if (
            runtimeCompactionError !== undefined ||
            toolBudgetError !== undefined ||
            toolIndeterminateError !== undefined ||
            (currentValidatedBuildCompletion !== undefined && !steering.hasPending())
          ) {
            return true;
          }
          if (stepCount >= BUILDER_TURN_MAX_MODEL_STEPS) {
            stepBudgetError ??= new BuilderTurnBudgetExceededError('max_steps');
            return true;
          }
          return false;
        },
        afterToolCall: async ({ result, isError }) =>
          !isError && !toolResultSucceeded(result.details) ? { isError: true } : undefined,
        maxTokens: piProvider.maxTokens,
        toolChoice: 'auto',
      };

      armInactivityWatchdog();
      let overflowRecoveryAttempted = false;
      while (true) {
        terminalAssistant = undefined;
        await runAgentLoopContinue(context, loopConfig, emit, loopSignal, piProvider.handle.stream);
        if (
          !terminalAssistant ||
          !isContextOverflow(terminalAssistant, piProvider.handle.model.contextWindow) ||
          overflowRecoveryAttempted ||
          currentTurnStreamedContent ||
          abortSignal?.aborted
        ) {
          break;
        }

        overflowRecoveryAttempted = true;
        if (context.messages.at(-1)?.role === 'assistant') {
          context = { ...context, messages: context.messages.slice(0, -1) };
        }
        const compacted = await compactRuntimeContext(context);
        if (!compacted) {
          break;
        }
        context = compacted;
      }

      recordPiStage('loop_complete', modelId);
      const finalAssistant = assistantMessageValue(terminalAssistant);
      if (runtimeCompactionError) {
        throw runtimeCompactionError;
      }
      if (toolIndeterminateError) {
        throw toolIndeterminateError;
      }
      if (toolBudgetError) {
        throw toolBudgetError;
      }
      if (stepBudgetError) {
        throw stepBudgetError;
      }
      const signalBudgetReason = exhaustedBudgetReason();
      if (signalBudgetReason) {
        throw new BuilderTurnBudgetExceededError(signalBudgetReason);
      }
      if (finalAssistant?.stopReason === 'error') {
        throw new Error(finalAssistant.errorMessage || 'The model request failed.');
      }
      if (finalAssistant?.stopReason === 'aborted' && !abortSignal?.aborted) {
        throw new Error(finalAssistant.errorMessage || 'The model request was aborted.');
      }
      const finalContextTokens = estimatePiContextTokens(context.messages);
      if (finalContextTokens >= compactionPolicy.proactiveTokens) {
        compaction.requestDurableCompaction?.();
      }
      recordWorkersAiFinish({
        usage: totalUsage,
        finishReason: finalAssistant?.stopReason ?? 'stop',
        firstUserMessage,
        contextReduced: modelInput.contextCompacted || runtimeContextCompacted,
        estimatedContextTokens: Math.max(modelInput.estimatedTokens, finalContextTokens),
        promptCharacterCounts,
        providerModel: modelId,
        startedAt,
      });
      terminalReason = abortSignal?.aborted ? 'cancelled' : 'completed';
    } catch (cause) {
      const error = budgetErrorForFailure(cause);
      terminalReason =
        error instanceof BuilderTurnBudgetExceededError ? error.reason : abortSignal?.aborted ? 'cancelled' : 'failed';
      recordPiStage('loop_error', modelId);
      logProviderFailure(logger, 'Pi agent runner failed.', error);
      if (
        (error instanceof BuilderTurnBudgetExceededError ||
          error instanceof WorkspaceToolOperationIndeterminateError) &&
        !abortSignal?.aborted
      ) {
        await writer.write({ type: 'error', errorText: error.message });
      } else if (error instanceof ContextCompactionUnavailableError && !abortSignal?.aborted) {
        await writer.write({ type: 'error', errorText: error.message });
      } else if (isWorkersAiFreeAllocationError(error)) {
        await writer.write({ type: 'error', errorText: workersPaidRequiredMessage() });
      } else if (isCloudflareAiFundingError(error)) {
        await writer.write({ type: 'error', errorText: cloudflareAiFundingRequiredMessage() });
      } else if (!abortSignal?.aborted) {
        await writer.write({ type: 'error', errorText: 'The model request failed. Please retry.' });
      }
    } finally {
      clearInactivityWatchdog();
      steering.close();
      const budget: BuilderTurnBudgetReport = {
        terminalReason,
        stepCount,
        toolCallCount,
        elapsedMs: Date.now() - startedAt,
        lastValidationState: currentValidatedBuildCompletion === undefined ? 'unvalidated' : 'validated',
      };
      recordPiTurnBudget(modelId, budget);
      onSettled(budget);
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
          finishReason: terminalAssistant?.stopReason === 'length' ? 'length' : 'stop',
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
  const payload = toolErrorPayload(result);
  return payload?.code === BUILDER_TURN_BUDGET_ERROR_CODE && payload.reason === 'tool_timeout'
    ? new BuilderTurnBudgetExceededError('tool_timeout')
    : undefined;
}

function toolIndeterminateErrorFromResult(result: unknown): WorkspaceToolOperationIndeterminateError | undefined {
  const payload = toolErrorPayload(result);
  return payload?.code === WORKSPACE_TOOL_OPERATION_INDETERMINATE_CODE && typeof payload.error === 'string'
    ? new WorkspaceToolOperationIndeterminateError(payload.error)
    : undefined;
}

function toolErrorPayload(result: unknown): { code?: unknown; error?: unknown; reason?: unknown } | undefined {
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
    const payload: unknown = JSON.parse(text);
    return isRecord(payload) ? payload : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `terminalAssistant` is only ever assigned from the event handler, so control-flow analysis still
 * believes it is `undefined` where the loop result is read. Passing it through a declared parameter
 * restores its declared type without asserting anything.
 */
function assistantMessageValue(message: AssistantMessage | undefined): AssistantMessage | undefined {
  return message;
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

function eventContentIndex(event: AssistantMessageEvent): number | undefined {
  return 'contentIndex' in event ? event.contentIndex : undefined;
}

/** The tool call a `toolcall_start` event opened, taken from the partial message it carries. */
function streamedToolCall(
  event: Extract<AssistantMessageEvent, { type: 'toolcall_start' }>,
): { contentIndex: number; toolCallId: string; toolName: string } | undefined {
  const call = event.partial.content[event.contentIndex];
  if (call?.type !== 'toolCall' || !call.id || !call.name) {
    return undefined;
  }
  return { contentIndex: event.contentIndex, toolCallId: call.id, toolName: call.name };
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
