import { useAgentChat } from '@cloudflare/ai-chat/react';
import { useAgent } from 'agents/react';
import type { UIMessage } from 'ai';
import { useStore } from '@nanostores/react';
import { useCallback, useEffect, useRef } from 'react';
import type { BuilderAgent, BuilderAgentState } from '~/agents/builder-agent';
import { workbenchStore } from '~/lib/stores/workbench.client';
import { ToolCallAbortedError } from '~/lib/stores/workbench-artifacts';
import { chatSyncState } from '~/lib/stores/startup/chatSyncState';
import { getAuthToken, sessionIdStore } from '~/lib/stores/sessionId';
import { captureMessage } from '~/lib/telemetry.client';
import { ChatContextManager } from 'ghostbuild-agent/ChatContextManager';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import type { GhostbuildMessage, GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import { STATUS_MESSAGES } from './StreamingIndicator';
import { recordChatFailure, resetChatRetryState } from './chat-retry';
import { subchatIndexStore } from '~/lib/stores/subchats';
import { buildBuilderAgentRequest } from './builder-agent-request';
import { waitForAgentSocketOpen } from './agent-connection';
import { deliverToolOutput } from './tool-output-delivery';
import { toast } from 'sonner';
import { WORKERS_PAID_REQUIRED_MARKER } from '~/lib/workers-paid';
import { refreshChatHistory } from '~/lib/cloudflare/chat-history-db';
import { chatIdStore } from '~/lib/stores/chatId';
import { executeDataOperation } from '~/lib/cloudflare/client';
import { api } from '~/lib/cloudflare/data-api';
import { description as descriptionStore } from '~/lib/stores/description';

const logger = createScopedLogger('BuilderAgentChat');
const AGENT_SEND_READY_TIMEOUT_MS = 10_000;

export function useBuilderAgentChat(args: {
  chatInitialId: string;
  initialMessages: GhostbuildMessage[];
  resetMessagesOnSubchatChange: boolean;
}) {
  const syncState = useStore(chatSyncState);
  const stopRef = useRef<() => void>(() => undefined);
  const contextManager = useRef(
    new ChatContextManager(
      () => workbenchStore.currentDocument.get(),
      () => workbenchStore.files.get(),
      () => workbenchStore.userWrites,
    ),
  );
  const builderAgent = useAgent<BuilderAgent, BuilderAgentState>({
    agent: 'BuilderAgent',
    name: args.chatInitialId,
  });
  const chat = useAgentChat<BuilderAgentState, UIMessage>({
    agent: builderAgent,
    getInitialMessages: null,
    messages: args.initialMessages as UIMessage[],
    experimental_throttle: 100,
    prepareSendMessagesRequest: ({ messages, body }) => {
      const ghostMessages = messages as GhostbuildMessage[];
      if (!getAuthToken()) {
        throw new Error('No token');
      }
      const requestBody = buildBuilderAgentRequest({
        messages: ghostMessages,
        body,
        chatInitialId: args.chatInitialId,
        subchatIndex: subchatIndexStore.get() ?? 0,
      });
      return { body: requestBody };
    },
    onToolCall({ toolCall, addToolOutput }) {
      logger.debug('Starting tool call', toolCall);
      void (async () => {
        const invocation: GhostbuildToolInvocation = {
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          args: toolCall.input,
          state: 'call',
        };
        try {
          const { result } = await workbenchStore.runToolInvocation(invocation);
          deliverToolOutput({
            deliver: addToolOutput,
            output: { toolCallId: toolCall.toolCallId, output: result },
            onFailure: (deliveryError) =>
              handleToolOutputDeliveryFailure(deliveryError, toolCall.toolName, stopRef.current),
          });
        } catch (error) {
          if (error instanceof ToolCallAbortedError) {
            logger.debug('Tool call waiter aborted', toolCall.toolCallId);
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          deliverToolOutput({
            deliver: addToolOutput,
            output: { toolCallId: toolCall.toolCallId, state: 'output-error', errorText: message },
            onFailure: (deliveryError) =>
              handleToolOutputDeliveryFailure(deliveryError, toolCall.toolName, stopRef.current),
          });
          captureMessage('Builder client tool call failed', {
            level: 'error',
            extra: { error, toolCallId: toolCall.toolCallId, toolName: toolCall.toolName },
          });
        }
      })();
    },
    autoContinueAfterToolResult: true,
    onError: (error: Error) => {
      captureMessage(`Failed to process chat request: ${error.message}`, {
        level: 'error',
        extra: { error },
      });
      logger.error('Chat request failed', error);
      recordChatFailure(error.message.includes(STATUS_MESSAGES.error));
      workbenchStore.abortAllActions();
      if (error.message.includes(WORKERS_PAID_REQUIRED_MARKER)) {
        toast.warning(
          'Your Cloudflare Workers AI free allocation is exhausted. Ghostbuild did not change your plan; authorize Workers Paid in Cloudflare if you want to continue.',
          {
            action: {
              label: 'Review Workers Paid',
              onClick: () =>
                window.open('https://dash.cloudflare.com/?to=/:account/workers/plans', '_blank', 'noopener'),
            },
          },
        );
      }
      void showAiAllowanceReminder();
      void refreshProjectMetadata();
    },
    onFinish: ({ finishReason }) => {
      if (finishReason === 'stop') {
        resetChatRetryState();
      }
      logger.debug('Finished streaming');
      void showAiAllowanceReminder();
      void refreshProjectMetadata();
    },
  });
  stopRef.current = chat.stop;
  const sendMessage = useCallback(
    async (...sendArgs: Parameters<typeof chat.sendMessage>) => {
      try {
        await waitForAgentSocketOpen(builderAgent, AGENT_SEND_READY_TIMEOUT_MS, { requireIdentity: false });
      } catch (error) {
        logger.warn('Builder connection was not ready before send', error);
        captureMessage('Builder connection was not ready before send', {
          level: 'error',
          extra: { error },
        });
        throw error;
      }
      return chat.sendMessage(...sendArgs);
    },
    [builderAgent, chat],
  );
  const setMessagesRef = useRef(chat.setMessages);
  const initialMessagesRef = useRef(args.initialMessages);
  setMessagesRef.current = chat.setMessages;
  initialMessagesRef.current = args.initialMessages;

  useEffect(() => {
    if (!args.resetMessagesOnSubchatChange) {
      return;
    }
    setMessagesRef.current(initialMessagesRef.current as UIMessage[]);
    contextManager.current.reset();
  }, [args.resetMessagesOnSubchatChange, syncState.subchatIndex]);

  return {
    ...chat,
    sendMessage,
    messages: chat.messages as GhostbuildMessage[],
    contextManager: contextManager.current,
    streamStatus: chat.isRecovering ? ('submitted' as const) : chat.isStreaming ? ('streaming' as const) : chat.status,
  };
}

type AiAllowanceResponse = {
  usageDate: string;
  usedPercent: number;
  exhausted: boolean;
  reminder: 0 | 50 | 90;
};

async function showAiAllowanceReminder(): Promise<void> {
  try {
    const response = await fetch('/api/ai/allowance');
    if (!response.ok) {
      return;
    }
    const allowance = (await response.json()) as AiAllowanceResponse;
    if (allowance.reminder === 0) {
      return;
    }
    const key = `ghostbuild.ai-allowance-reminder:${allowance.usageDate}:${allowance.reminder}`;
    if (sessionStorage.getItem(key)) {
      return;
    }
    sessionStorage.setItem(key, 'shown');
    if (allowance.reminder === 90) {
      toast.warning(
        allowance.exhausted
          ? "Today's free AI allowance is used. Connect Cloudflare to continue building."
          : "You have used over 90% of today's free AI allowance. Connect Cloudflare to avoid interruption.",
        connectCloudflareToastAction,
      );
      return;
    }
    toast.info(
      "You have used over half of today's free AI allowance. Connect Cloudflare to keep building.",
      connectCloudflareToastAction,
    );
  } catch (error) {
    logger.debug('Unable to load AI allowance status', error);
  }
}

async function refreshProjectMetadata(attempt = 0): Promise<void> {
  const sessionId = sessionIdStore.get();
  const chatId = chatIdStore.get();
  if (typeof sessionId !== 'string' || !chatId) {
    return;
  }
  try {
    const [, chat] = await Promise.all([
      refreshChatHistory(sessionId),
      executeDataOperation(api.messages.get, { id: chatId, sessionId }),
    ]);
    if (chat?.description) {
      descriptionStore.set(chat.description);
    } else if (attempt < 2) {
      window.setTimeout(() => void refreshProjectMetadata(attempt + 1), (attempt + 1) * 1_000);
    }
  } catch (error) {
    logger.debug('Unable to refresh generated project title', error);
  }
}

const connectCloudflareToastAction = {
  action: {
    label: 'Connect Cloudflare',
    onClick: () => window.location.assign('/settings#cloudflare'),
  },
};

function handleToolOutputDeliveryFailure(error: unknown, toolName: string, stop: () => void): void {
  logger.error('Failed to deliver tool output for continuation', error);
  captureMessage('Failed to deliver Builder tool output for continuation', {
    level: 'error',
    extra: { error, toolName },
  });
  workbenchStore.abortAllActions();
  stop();
}
