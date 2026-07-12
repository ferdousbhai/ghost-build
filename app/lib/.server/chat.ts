import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { workersAiAgent } from '~/lib/.server/llm/workers-ai-agent';
import { createUIMessageStreamResponse } from 'ai';
import { calculatePromptCharacterCounts } from 'ghostbuild-agent/context-message-metrics';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { ROLE_SYSTEM_PROMPT, generalSystemPrompt } from 'ghostbuild-agent/prompts/system';
import { ModelInputBudgetExceededError } from './llm/model-input-budget';
import type { ChatTurnContext } from 'ghostbuild-agent/turn-context';

type Messages = GhostbuildMessage[];

const logger = createScopedLogger('api.chat');

export type ChatRequestBody = {
  messages?: Messages;
  chatInitialId: string;
  subchatIndex: number;
  turnContext?: ChatTurnContext;
  shouldDisableTools: boolean;
};

export async function createChatResponseFromBody({
  abortSignal,
  body,
  contextReduced,
  env,
  firstUserMessage,
  preparedMessages,
}: {
  abortSignal?: AbortSignal;
  body: Pick<ChatRequestBody, 'messages' | 'chatInitialId' | 'shouldDisableTools'>;
  contextReduced: boolean;
  env: Env;
  firstUserMessage: boolean;
  preparedMessages: Messages;
}) {
  const { messages, chatInitialId } = body;
  const transcriptMessages = messages ?? [];
  const modelMessages = preparedMessages;
  const systemPrompts = [ROLE_SYSTEM_PROMPT, generalSystemPrompt()];
  const promptCharacterCounts = calculatePromptCharacterCounts(modelMessages, systemPrompts);

  logger.info('Using Cloudflare Workers AI');

  try {
    const dataStream = await workersAiAgent({
      env,
      abortSignal,
      chatInitialId,
      firstUserMessage,
      messages: transcriptMessages,
      promptMessages: modelMessages,
      shouldDisableTools: body.shouldDisableTools,
      contextReduced,
      promptCharacterCounts,
    });

    return createUIMessageStreamResponse({ stream: dataStream });
  } catch (error: unknown) {
    logger.error('Workers AI chat request failed', error);

    if (error instanceof ModelInputBudgetExceededError) {
      throw new Response(error.message, {
        status: 413,
        statusText: 'Current request is too large',
      });
    }

    throw new Response(null, {
      status: 500,
      statusText: 'Internal Server Error',
    });
  }
}
