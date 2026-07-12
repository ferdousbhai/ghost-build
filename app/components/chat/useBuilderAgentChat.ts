import { useAgentChat } from '@cloudflare/ai-chat/react';
import { useAgent } from 'agents/react';
import type { UIMessage } from 'ai';
import { useStore } from '@nanostores/react';
import { useCallback, useEffect, useRef } from 'react';
import type { BuilderAgent, BuilderAgentState } from '~/agents/builder-agent';
import { workbenchStore } from '~/lib/stores/workbench.client';
import { ToolCallAbortedError } from '~/lib/stores/workbench-artifacts';
import { chatSyncState } from '~/lib/stores/startup/chatSyncState';
import { getAuthToken } from '~/lib/stores/sessionId';
import { captureMessage } from '~/lib/telemetry.client';
import { ChatContextManager } from 'ghostbuild-agent/ChatContextManager';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import type { GhostbuildMessage, GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import { STATUS_MESSAGES } from './StreamingIndicator';
import { recordChatFailure, resetChatRetryState } from './chat-retry';
import { subchatIndexStore } from '~/lib/stores/subchats';
import { buildBuilderAgentRequest } from './builder-agent-request';
import { waitForAgentSocketOpen } from './agent-connection';

const logger = createScopedLogger('BuilderAgentChat');
const AGENT_SEND_READY_TIMEOUT_MS = 10_000;

export function useBuilderAgentChat(args: {
  chatInitialId: string;
  initialMessages: GhostbuildMessage[];
  resetMessagesOnSubchatChange: boolean;
}) {
  const syncState = useStore(chatSyncState);
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
          addToolOutput({ toolCallId: toolCall.toolCallId, output: result });
        } catch (error) {
          if (error instanceof ToolCallAbortedError) {
            logger.debug('Tool call waiter aborted', toolCall.toolCallId);
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          addToolOutput({ toolCallId: toolCall.toolCallId, state: 'output-error', errorText: message });
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
    },
    onFinish: ({ finishReason }) => {
      if (finishReason === 'stop') {
        resetChatRetryState();
      }
      logger.debug('Finished streaming');
    },
  });
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
