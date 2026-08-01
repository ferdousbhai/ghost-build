import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { workersAiAgent } from '~/lib/.server/llm/workers-ai-agent';
import { createUIMessageStreamResponse } from 'ai';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { ContextCompactionUnavailableError, ModelInputBudgetExceededError } from './llm/model-input';
import type { ChatTurnContext } from 'ghostbuild-agent/turn-context';
import type { WorkersAiAccountCredentials } from './llm/provider';
import type { ContextCompaction } from './llm/context-compaction';
import type { BuilderWorkspaceApi } from '~/agents/builder-workspace-api';
import type { BuilderValidationStage } from '~/lib/common/builder-validation-progress';

type Messages = GhostbuildMessage[];

const logger = createScopedLogger('api.chat');

export type ChatRequestBody = {
  messages?: Messages;
  chatInitialId: string;
  subchatIndex: number;
  turnContext?: ChatTurnContext;
};

export async function createChatResponseFromBody({
  abortSignal,
  body,
  compaction,
  env,
  firstUserMessage,
  turnContext,
  accountCredentials,
  sessionAffinity,
  workspace,
  userId,
  agentName,
  onValidationStage,
}: {
  abortSignal?: AbortSignal;
  body: Pick<ChatRequestBody, 'messages' | 'chatInitialId'>;
  compaction: {
    current: ContextCompaction | null;
    pending: boolean;
    summarize: (prompt: string) => Promise<string>;
    save: (compaction: ContextCompaction) => void;
    schedule?: () => Promise<void>;
  };
  env: Env;
  firstUserMessage: boolean;
  turnContext?: ChatTurnContext;
  accountCredentials: WorkersAiAccountCredentials;
  sessionAffinity: string;
  workspace: BuilderWorkspaceApi;
  userId: string;
  agentName: string;
  onValidationStage?: (toolCallId: string, stage: BuilderValidationStage | null) => void;
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
      compaction,
      accountCredentials,
      sessionAffinity,
      workspace,
      userId,
      agentName,
      onValidationStage,
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

    throw new Response(null, {
      status: 500,
      statusText: 'Internal Server Error',
    });
  }
}
