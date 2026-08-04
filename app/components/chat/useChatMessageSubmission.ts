import { useEffect, useRef, useState } from 'react';
import { formatDistanceStrict } from 'date-fns';
import { toast } from 'sonner';
import type { ChatContextManager } from 'ghostbuild-agent/ChatContextManager';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { filesToTurnContext } from '~/utils/fileUtils';
import { captureMessage, captureProductEvent } from '~/lib/telemetry.client';
import { isStreamStatusActive, type StreamStatus } from '~/lib/common/types';
import { chatStore } from '~/lib/stores/chatId';
import { workbenchStore } from '~/lib/stores/workbench.client';
import { messageInputStore } from '~/lib/stores/messageInput';
import { getChatRetryState, MAX_CHAT_RETRIES } from './chat-retry';
import { MAX_EPHEMERAL_CONTEXT_CHARACTERS } from 'ghostbuild-agent/context-limits';
import type { ChatTurnContext } from 'ghostbuild-agent/turn-context';
import { toolActivityStore } from '~/lib/stores/tool-activity.client';

const logger = createScopedLogger('ChatMessageSubmission');

export function useChatMessageSubmission(args: {
  messages: GhostbuildMessage[];
  contextManager: ChatContextManager;
  chatStarted: boolean;
  streamStatus: StreamStatus;
  initializeChat: () => Promise<{ created: boolean }>;
  discardEmptyChat: () => Promise<void>;
  sendChatMessage: (
    message: { text: string },
    options?: { body?: { turnContext?: ChatTurnContext } },
    onRequestStart?: () => void,
  ) => Promise<unknown>;
  enableAutoScroll: () => void;
  onAbort: () => void;
  onStartChat: () => void | Promise<void>;
  onFirstPrompt: (prompt: string) => void;
  onBuilderRequestStart: () => void;
  pendingMessage: string | null;
  clearPendingMessage: () => void;
}) {
  const [sendMessageInProgress, setSendMessageInProgress] = useState(false);
  const [pendingUserMessage, setPendingUserMessage] = useState<PendingUserMessage | null>(null);
  const sendMessageInProgressRef = useRef(false);
  const pendingMessageSequenceRef = useRef(0);

  const sendMessage = async (messageInput: string): Promise<boolean> => {
    const retries = getChatRetryState();
    if (retries.numFailures >= MAX_CHAT_RETRIES || Date.now() < retries.nextRetry) {
      const retryMessage =
        retries.numFailures >= MAX_CHAT_RETRIES
          ? 'Ghostbuild is too busy building right now. Please try again later.'
          : `Ghostbuild is too busy building right now. Please try again in ${formatDistanceStrict(
              Date.now(),
              retries.nextRetry,
            )}.`;
      toast.error(retryMessage);
      captureMessage('User tried to send message but Ghostbuild is too busy');
      return false;
    }
    if (isStreamStatusActive(args.streamStatus)) {
      args.onAbort();
      return false;
    }
    if (sendMessageInProgressRef.current) {
      logger.debug('Message submission already in progress');
      return false;
    }
    try {
      sendMessageInProgressRef.current = true;
      setSendMessageInProgress(true);
      setPendingUserMessage({
        id: `pending-user-message-${Date.now()}-${pendingMessageSequenceRef.current++}`,
        text: messageInput,
        previousUserMessageCount: args.messages.filter((message) => message.role === 'user').length,
      });
      args.enableAutoScroll();
      if (!args.messages.some((message) => message.role === 'user')) {
        args.onFirstPrompt(messageInput);
      }
      await runChatSubmissionLifecycle({
        initializeChat: args.initializeChat,
        discardEmptyChat: args.discardEmptyChat,
        onStartChat: args.onStartChat,
        onBuilderRequestStart: args.onBuilderRequestStart,
        submit: (onRequestStart) =>
          submitMessage(
            args.messages,
            args.contextManager,
            messageInput,
            args.chatStarted,
            args.sendChatMessage,
            onRequestStart,
          ),
      });
      return true;
    } catch (error) {
      logger.error('Failed to submit chat message', error);
      const message = error instanceof Error ? error.message : 'Ghostbuild could not start building. Please try again.';
      toast.error(message);
      captureMessage('Failed to submit chat message', { level: 'error' });
      return false;
    } finally {
      sendMessageInProgressRef.current = false;
      setSendMessageInProgress(false);
      setPendingUserMessage(null);
    }
  };

  const sendMessageRef = useRef(sendMessage);
  sendMessageRef.current = sendMessage;
  const pendingMessageStarted = useRef(false);
  const mountedRef = useRef(true);
  const { pendingMessage, clearPendingMessage } = args;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!pendingMessage) {
      pendingMessageStarted.current = false;
      return;
    }
    if (pendingMessageStarted.current) {
      return;
    }
    pendingMessageStarted.current = true;
    if (!messageInputStore.get()) {
      messageInputStore.set(pendingMessage);
    }
    void (async () => {
      const sent = await sendMessageRef.current(pendingMessage);
      if (!mountedRef.current) {
        return;
      }
      clearPendingMessage();
      if (sent && messageInputStore.get() === pendingMessage) {
        messageInputStore.set('');
      } else if (!sent) {
        messageInputStore.set(pendingMessage);
      }
    })();
  }, [clearPendingMessage, pendingMessage]);

  return { pendingUserMessage, sendMessage, sendMessageInProgress };
}

export interface PendingUserMessage {
  id: string;
  text: string;
  previousUserMessageCount: number;
}

export function appendPendingUserMessage(
  messages: GhostbuildMessage[],
  pendingMessage: PendingUserMessage | null,
): GhostbuildMessage[] {
  if (
    !pendingMessage ||
    messages.filter((message) => message.role === 'user').length > pendingMessage.previousUserMessageCount
  ) {
    return messages;
  }

  return [
    ...messages,
    {
      id: pendingMessage.id,
      role: 'user',
      parts: [{ type: 'text', text: pendingMessage.text }],
    },
  ];
}

export async function runChatSubmissionLifecycle(args: {
  initializeChat: () => Promise<{ created: boolean }>;
  discardEmptyChat: () => Promise<void>;
  onStartChat: () => void | Promise<void>;
  onBuilderRequestStart: () => void;
  submit: (onRequestStart: () => void) => Promise<void>;
}): Promise<void> {
  const initializedChat = await args.initializeChat();
  let builderRequestStarted = false;
  try {
    void Promise.resolve(args.onStartChat()).catch((error) => logger.warn('Chat transition failed', error));
  } catch (error) {
    logger.warn('Chat transition failed', error);
  }
  try {
    await args.submit(() => {
      builderRequestStarted = true;
      args.onBuilderRequestStart();
    });
  } catch (error) {
    if (initializedChat.created && !builderRequestStarted) {
      try {
        await args.discardEmptyChat();
      } catch (discardError) {
        logger.warn('Failed to discard an empty chat after submission failed', discardError);
      }
    }
    throw error;
  }
}

async function submitMessage(
  messages: GhostbuildMessage[],
  contextManager: ChatContextManager,
  messageInput: string,
  chatStarted: boolean,
  sendChatMessage: (
    message: { text: string },
    options?: { body?: { turnContext?: ChatTurnContext } },
    onRequestStart?: () => void,
  ) => Promise<unknown>,
  onRequestStart: () => void,
): Promise<void> {
  const id = `${Date.now()}`;
  workbenchStore.flushPendingEditorChange();
  void captureProductEvent('prompt_submitted');
  const modifiedFiles = chatStarted ? workbenchStore.getModifiedFiles() : undefined;
  const modifiedContext = modifiedFiles ? filesToTurnContext(modifiedFiles) : '';
  const separatorCharacters = modifiedContext ? 2 : 0;
  const relevantBudget = Math.max(0, MAX_EPHEMERAL_CONTEXT_CHARACTERS - modifiedContext.length - separatorCharacters);
  const relevantContext = contextManager
    .relevantFiles(messages, id, relevantBudget)
    .parts.map((part) => (part.type === 'text' ? part.text : ''))
    .join('');
  const content = [modifiedContext, relevantContext].filter(Boolean).join('\n\n');
  const turnContext: ChatTurnContext = { version: 1, content };

  toolActivityStore.startTurn();
  chatStore.setKey('aborted', false);
  await sendChatMessage({ text: messageInput }, { body: { turnContext } }, onRequestStart);
  if (modifiedFiles) {
    workbenchStore.resetAllFileModifications();
  }
}
