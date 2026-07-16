import { createUIMessageStream, streamText, type UIMessage, type UIMessageChunk } from 'ai';
import { languageModelId, type GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import type { PromptCharacterCounts } from 'ghostbuild-agent/context-message-metrics';
import { ROLE_SYSTEM_PROMPT, generalSystemPrompt } from 'ghostbuild-agent/prompts/system';
import { logger } from 'ghostbuild-agent/utils/logger';
import { CLOUDFLARE_WORKERS_AI_MODEL } from '~/lib/workers-ai-model';
import { asAiSdkTools, asOriginalMessages } from './message-conversion';
import { getProvider, type WorkersAiAccountCredentials } from './provider';
import { prepareBoundedModelInput } from './model-input-budget';
import { normalizeTextPartBoundaries } from './workers-ai-stream';
import { recordFirstWorkersAiResponse, recordWorkersAiFinish } from './workers-ai-telemetry';
import {
  createWorkersAiTools,
  getValidatedBuildCompletion,
  getWorkersAiBuildGuidance,
  getWorkersAiToolSettings,
  type AgentToolSettings,
} from './workers-ai-tools';
import { glm52CostNanodollars } from '~/lib/.server/billing/ai-allowance-policy';
import {
  releaseAiAllowance,
  reserveAiAllowance,
  settleAiAllowance,
} from '~/lib/.server/billing/ai-allowance-repository';
import { normalizeWorkersAiUsage } from '~/lib/.server/billing/workers-ai-usage';
import { isWorkersAiFreeAllocationError, workersPaidRequiredMessage } from '~/lib/workers-paid';

type Messages = GhostbuildMessage[];
const WORKERS_AI_CALL_TIMEOUT_MS = 180_000;

interface WorkersAiAgentOptions {
  env: Env;
  abortSignal?: AbortSignal;
  chatInitialId: string;
  firstUserMessage: boolean;
  messages: Messages;
  promptMessages: Messages;
  shouldDisableTools: boolean;
  contextReduced: boolean;
  promptCharacterCounts: PromptCharacterCounts;
  billingSubjectKey: string;
  accountCredentials?: WorkersAiAccountCredentials;
}

export async function workersAiAgent(options: WorkersAiAgentOptions): Promise<ReadableStream<UIMessageChunk>> {
  const {
    env,
    abortSignal,
    chatInitialId,
    firstUserMessage,
    messages,
    promptMessages,
    shouldDisableTools,
    contextReduced,
    promptCharacterCounts,
    billingSubjectKey,
    accountCredentials,
  } = options;
  logger.debug('Starting Workers AI agent');
  const startedAt = Date.now();
  let recordedFirstResponse = false;
  const provider = getProvider(env, accountCredentials);
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
  const modelInput = await prepareBoundedModelInput({
    uiMessages: promptMessages,
    systemPrompts,
    tools,
    toolChoice: toolSettings.toolChoice,
    activeTools: toolSettings.activeTools,
  });
  const reservation = accountCredentials
    ? undefined
    : await reserveAiAllowance(
        env.DB,
        billingSubjectKey,
        glm52CostNanodollars({
          inputTokens: modelInput.estimatedTokens,
          outputTokens: provider.maxTokens,
        }),
      );
  let reservationFinalized = false;
  const releaseReservation = async () => {
    if (reservationFinalized) {
      return;
    }
    reservationFinalized = true;
    if (reservation) {
      await releaseAiAllowance(env.DB, reservation.id);
    }
  };

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
      onFinish: async (finishResult) => {
        recordWorkersAiFinish({
          result: finishResult,
          chatInitialId,
          firstUserMessage,
          toolsDisabledFromRepeatedErrors: shouldDisableTools,
          contextReduced: contextReduced || modelInput.reduced,
          estimatedContextTokens: modelInput.estimatedTokens,
          modelInputDroppedMessageCount: modelInput.droppedMessageCount,
          promptCharacterCounts,
          providerModel: languageModelId(provider.model, CLOUDFLARE_WORKERS_AI_MODEL),
        });
        if (reservationFinalized || !reservation) {
          return;
        }
        reservationFinalized = true;
        const usage = normalizeWorkersAiUsage(finishResult.totalUsage, finishResult.providerMetadata);
        const allowance = await settleAiAllowance(env.DB, reservation.id, glm52CostNanodollars(usage), usage);
        if (allowance?.reminder) {
          console.info({
            event: 'ghostbuild_ai_allowance_threshold_reached',
            threshold: allowance.reminder,
            usedPercent: allowance.usedPercent,
          });
        }
      },
      onError: async ({ error }) => {
        logger.error(error);
        await releaseReservation();
      },
    });
  } catch (error) {
    await releaseReservation();
    throw error;
  }

  const stream = result.toUIMessageStream({
    originalMessages: asOriginalMessages(messages),
    onError: (error) => {
      if (accountCredentials && isWorkersAiFreeAllocationError(error)) {
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
