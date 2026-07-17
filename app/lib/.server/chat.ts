import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { workersAiAgent } from '~/lib/.server/llm/workers-ai-agent';
import { createUIMessageStreamResponse } from 'ai';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { ContextCompactionUnavailableError, ModelInputBudgetExceededError } from './llm/model-input';
import type { ChatTurnContext } from 'ghostbuild-agent/turn-context';
import { AiAllowanceExceededError } from './billing/ai-allowance-repository';
import type { WorkersAiAccountCredentials } from './llm/provider';
import type { ContextCompaction } from './llm/context-compaction';

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
  compaction,
  env,
  firstUserMessage,
  turnContext,
  billingSubjectKey,
  accountCredentials,
  sessionAffinity,
}: {
  abortSignal?: AbortSignal;
  body: Pick<ChatRequestBody, 'messages' | 'chatInitialId' | 'shouldDisableTools'>;
  compaction: {
    current: ContextCompaction | null;
    summarize: (prompt: string) => Promise<string>;
    save: (compaction: ContextCompaction) => void;
  };
  env: Env;
  firstUserMessage: boolean;
  turnContext?: ChatTurnContext;
  billingSubjectKey: string;
  accountCredentials?: WorkersAiAccountCredentials;
  sessionAffinity: string;
}) {
  const { messages, chatInitialId } = body;
  const transcriptMessages = messages ?? [];

  logger.info('Using Cloudflare Workers AI');

  try {
    const dataStream = await workersAiAgent({
      env,
      abortSignal,
      chatInitialId,
      firstUserMessage,
      messages: transcriptMessages,
      turnContext,
      shouldDisableTools: body.shouldDisableTools,
      compaction,
      billingSubjectKey,
      accountCredentials,
      sessionAffinity,
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

    if (error instanceof ContextCompactionUnavailableError) {
      throw new Response(error.message, {
        status: 503,
        statusText: 'Context compaction unavailable',
      });
    }

    if (error instanceof AiAllowanceExceededError) {
      throw new Response(error.message, {
        status: 429,
        statusText: 'Daily AI allowance used',
      });
    }

    throw new Response(null, {
      status: 500,
      statusText: 'Internal Server Error',
    });
  }
}
