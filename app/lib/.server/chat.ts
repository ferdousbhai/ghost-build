import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { workersAiAgent } from '~/lib/.server/llm/workers-ai-agent';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { BatchSpanProcessor, WebTracerProvider } from '@opentelemetry/sdk-trace-web';
import { createUIMessageStreamResponse } from 'ai';
import { getOptionalBinding } from '~/lib/.server/env';
import type { PromptCharacterCounts } from 'ghostbuild-agent/ChatContextManager';
import { messageText, type GhostbuildMessage } from 'ghostbuild-agent/ai-compat';

type Messages = GhostbuildMessage[];

const logger = createScopedLogger('api.chat');

export type Tracer = ReturnType<typeof WebTracerProvider.prototype.getTracer>;

export type ChatRequestBody = {
  messages?: Messages;
  preparedMessages?: Messages;
  firstUserMessage?: boolean;
  chatInitialId: string;
  shouldDisableTools: boolean;
  collapsedMessages: boolean;
  promptCharacterCounts?: PromptCharacterCounts;
};

function createTracer(env: Env) {
  const AXIOM_API_TOKEN = getOptionalBinding(env, 'AXIOM_API_TOKEN');
  const AXIOM_API_URL = getOptionalBinding(env, 'AXIOM_API_URL');
  const AXIOM_DATASET_NAME = getOptionalBinding(env, 'AXIOM_DATASET_NAME');

  if (AXIOM_API_TOKEN && AXIOM_API_URL && AXIOM_DATASET_NAME) {
    const exporter = new OTLPTraceExporter({
      url: AXIOM_API_URL,
      headers: {
        Authorization: `Bearer ${AXIOM_API_TOKEN}`,
        'X-Axiom-Dataset': AXIOM_DATASET_NAME,
      },
    });
    const provider = new WebTracerProvider({
      spanProcessors: [
        new BatchSpanProcessor(exporter, {
          // The maximum queue size. After the size is reached spans are dropped.
          maxQueueSize: 100,
          // The maximum batch size of every export. It must be smaller or equal to maxQueueSize.
          maxExportBatchSize: 10,
          // The interval between two consecutive exports
          scheduledDelayMillis: 500,
          // How long the export can run before it is cancelled
          exportTimeoutMillis: 30000,
        }),
      ],
    });
    provider.register();
    logger.info('✅ Axiom instrumentation registered!');

    return provider.getTracer('ai');
  }

  logger.warn('⚠️ AXIOM_API_TOKEN, AXIOM_API_URL, and AXIOM_DATASET_NAME not set, skipping Axiom instrumentation.');
  return null;
}

export async function createChatResponseFromBody({
  abortSignal,
  body,
  env,
}: {
  abortSignal?: AbortSignal;
  body: ChatRequestBody;
  env: Env;
}) {
  const { messages, firstUserMessage, chatInitialId } = body;
  const transcriptMessages = messages ?? [];
  const modelMessages = body.preparedMessages ?? transcriptMessages;
  const tracer = createTracer(env);

  logger.info('Using Cloudflare Workers AI');

  try {
    const totalMessageContent = modelMessages.reduce((acc, message) => acc + messageText(message), '');
    logger.debug(`Total message length: ${totalMessageContent.split(' ').length}, words`);
    const dataStream = await workersAiAgent({
      env,
      abortSignal,
      chatInitialId,
      firstUserMessage:
        firstUserMessage ?? transcriptMessages.filter((message) => message.role === 'user').length === 1,
      messages: transcriptMessages,
      promptMessages: modelMessages,
      tracer,
      shouldDisableTools: body.shouldDisableTools,
      collapsedMessages: body.collapsedMessages,
      promptCharacterCounts: body.promptCharacterCounts,
    });

    return createUIMessageStreamResponse({ stream: dataStream });
  } catch (error: any) {
    logger.error(error);

    throw new Response(null, {
      status: 500,
      statusText: 'Internal Server Error',
    });
  }
}
