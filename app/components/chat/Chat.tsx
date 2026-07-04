import { useStore } from '@nanostores/react';
import { type UIMessage } from 'ai';
import { useAgent } from 'agents/react';
import { useAgentChat } from '@cloudflare/ai-chat/react';
import { useAnimate } from 'framer-motion';
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { BuilderAgent, BuilderAgentState } from '~/agents/builder-agent';
import { useMessageParser, type PartCache } from '~/lib/hooks/useMessageParser';
import { useSnapScroll } from '~/lib/hooks/useSnapScroll';
import { chatStore } from '~/lib/stores/chatId';
import { workbenchStore } from '~/lib/stores/workbench.client';
import { MAX_CONSECUTIVE_DEPLOY_ERRORS } from '~/utils/constants';
import { cubicEasingFn } from '~/utils/easings';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { BaseChat } from './BaseChat.client';
import { createSampler } from '~/utils/sampler';
import { filesToArtifacts } from '~/utils/fileUtils';
import { ChatContextManager } from 'ghostbuild-agent/ChatContextManager';
import { toast } from 'sonner';
import type { PartId } from '~/lib/stores/artifacts';
import type { ActionStatus, ActionState } from '~/lib/runtime/action-runner';
import { isStreamStatusActive, type StreamStatus } from '~/lib/common/types';
import { chatIdStore, initialIdStore } from '~/lib/stores/chatId';
import { executeDataOperation } from '~/lib/cloudflare/client';
import { api } from '~/lib/cloudflare/data-api';
import { formatDistanceStrict } from 'date-fns';
import { atom } from 'nanostores';
import { STATUS_MESSAGES } from './StreamingIndicator';
import { useSessionIdOrNullOrLoading } from '~/lib/stores/sessionId';
import { getAuthToken } from '~/lib/stores/sessionId';
import { chatSyncState } from '~/lib/stores/startup/chatSyncState';
import { getToolInvocation, toAiSdkMessageParts, type GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { captureMessage } from '~/lib/telemetry.client';
import { signInWithGoogle } from '~/lib/auth-client';

const logger = createScopedLogger('Chat');

const MAX_RETRIES = 4;

type StoreMessageHistory = (messages: GhostbuildMessage[], streamStatus: StreamStatus) => void | Promise<void>;

const processSampledMessages = createSampler(
  (options: {
    messages: GhostbuildMessage[];
    initialMessages: GhostbuildMessage[];
    parseMessages: (messages: GhostbuildMessage[]) => void;
    streamStatus: StreamStatus;
    storeMessageHistory: StoreMessageHistory;
  }) => {
    const { messages, initialMessages, parseMessages, storeMessageHistory, streamStatus } = options;
    parseMessages(messages);

    if (messages.length >= initialMessages.length) {
      Promise.resolve(storeMessageHistory(messages, streamStatus)).catch((error) => toast.error(error.message));
    }
  },
  50,
);

interface ChatProps {
  initialMessages: GhostbuildMessage[];
  partCache: PartCache;
  storeMessageHistory: StoreMessageHistory;
  initializeChat: () => Promise<boolean>;

  isReload: boolean;
  hadSuccessfulDeploy: boolean;
  subchats?: { subchatIndex: number; updatedAt: number; description?: string }[];
}

const retryState = atom({
  numFailures: 0,
  nextRetry: Date.now(),
});
export const Chat = memo(
  ({
    initialMessages,
    partCache,
    storeMessageHistory,
    initializeChat,
    isReload,
    hadSuccessfulDeploy,
    subchats,
  }: ChatProps) => {
    const sessionId = useSessionIdOrNullOrLoading();
    if (typeof sessionId !== 'string') {
      return (
        <UnauthenticatedChat
          initialMessages={initialMessages}
          isReload={isReload}
          hadSuccessfulDeploy={hadSuccessfulDeploy}
          subchats={subchats}
          authLoading={sessionId === undefined}
        />
      );
    }

    return (
      <AuthenticatedChat
        initialMessages={initialMessages}
        partCache={partCache}
        storeMessageHistory={storeMessageHistory}
        initializeChat={initializeChat}
        isReload={isReload}
        hadSuccessfulDeploy={hadSuccessfulDeploy}
        subchats={subchats}
      />
    );
  },
);
Chat.displayName = 'Chat';

function UnauthenticatedChat({
  initialMessages,
  isReload,
  hadSuccessfulDeploy,
  subchats,
  authLoading,
}: Pick<ChatProps, 'initialMessages' | 'isReload' | 'hadSuccessfulDeploy' | 'subchats'> & { authLoading: boolean }) {
  const hasMultipleSubchats = (subchats?.length ?? 0) > 1;
  const [chatStarted] = useState(initialMessages.length > 0 || hasMultipleSubchats);
  const actionAlert = useStore(workbenchStore.alert);
  const { messageRef, scrollRef } = useSnapScroll();
  const terminalInitializationOptions = useMemo(
    () => ({
      isReload,
      shouldRunWorkerBuild: hadSuccessfulDeploy || hasMultipleSubchats,
    }),
    [isReload, hadSuccessfulDeploy, hasMultipleSubchats],
  );

  return (
    <BaseChat
      messageRef={messageRef}
      scrollRef={scrollRef}
      showChat
      chatStarted={chatStarted}
      onStop={() => undefined}
      onSend={async () => {
        await signInWithGoogle(window.location.href);
      }}
      streamStatus="ready"
      isRecovering={false}
      currentError={undefined}
      toolStatus={{}}
      messages={initialMessages}
      actionAlert={actionAlert}
      clearAlert={() => workbenchStore.clearAlert()}
      terminalInitializationOptions={terminalInitializationOptions}
      disableChatMessage={authLoading ? 'Loading account...' : null}
      sendMessageInProgress={false}
      subchats={subchats}
    />
  );
}

const AuthenticatedChat = memo(
  ({
    initialMessages,
    partCache,
    storeMessageHistory,
    initializeChat,
    isReload,
    hadSuccessfulDeploy,
    subchats,
  }: ChatProps) => {
    const sessionId = useSessionIdOrNullOrLoading();
    const chatInitialId = useStore(initialIdStore);
    const hasMultipleSubchats = (subchats?.length ?? 0) > 1;
    const [chatStarted, setChatStarted] = useState(initialMessages.length > 0 || hasMultipleSubchats);
    const actionAlert = useStore(workbenchStore.alert);
    const syncState = useStore(chatSyncState);

    const rewindToMessage = async (subchatIndex?: number, messageIndex?: number) => {
      if (sessionId && typeof sessionId === 'string') {
        const chatId = chatIdStore.get();
        if (!chatId) {
          return;
        }
        if (subchatIndex === undefined) {
          return;
        }

        const url = new URL(window.location.href);
        url.searchParams.set('rewind', 'true');

        try {
          await executeDataOperation(api.messages.rewindChat, {
            sessionId,
            chatId,
            subchatIndex,
            lastMessageRank: messageIndex,
          });
          // Reload the chat to show the rewound state
          window.location.replace(url.href);
        } catch (error) {
          logger.error('Failed to rewind chat:', error);
          toast.error('Failed to rewind chat');
        }
      }
    };
    const { showChat } = useStore(chatStore);

    const [animationScope, animate] = useAnimate();

    const terminalInitializationOptions = useMemo(
      () => ({
        isReload,
        shouldRunWorkerBuild: hadSuccessfulDeploy || hasMultipleSubchats,
      }),
      [isReload, hadSuccessfulDeploy, hasMultipleSubchats],
    );

    useEffect(() => {
      const url = new URL(window.location.href);
      if (url.searchParams.get('rewind') === 'true') {
        toast.info('Successfully reverted changes. You may need to clear or migrate your stored app data.');
      }
    }, []);

    // Reset retries counter every minute
    useEffect(() => {
      const resetInterval = setInterval(() => {
        retryState.set({ numFailures: 0, nextRetry: Date.now() });
      }, 60 * 1000);
      return () => clearInterval(resetInterval);
    }, []);

    const chatContextManager = useRef(
      new ChatContextManager(
        () => workbenchStore.currentDocument.get(),
        () => workbenchStore.files.get(),
        () => workbenchStore.userWrites,
      ),
    );

    const [sendMessageInProgress, setSendMessageInProgress] = useState(false);

    const builderAgent = useAgent<BuilderAgent, BuilderAgentState>({
      agent: 'BuilderAgent',
      name: chatInitialId,
    });

    const {
      messages,
      status,
      stop,
      sendMessage: sendChatMessage,
      setMessages,
      error,
      isStreaming,
      isRecovering,
    } = useAgentChat<BuilderAgentState, UIMessage>({
      agent: builderAgent,
      messages: initialMessages as UIMessage[],
      prepareSendMessagesRequest: ({ messages }) => {
        const ghostMessages = messages as GhostbuildMessage[];
        if (!getAuthToken()) {
          throw new Error('No token');
        }
        const { messages: preparedMessages, collapsedMessages } =
          chatContextManager.current.prepareContext(ghostMessages);

        const characterCounts = chatContextManager.current.calculatePromptCharacterCounts(preparedMessages);

        return {
          body: {
            preparedMessages,
            firstUserMessage: ghostMessages.filter((message) => message.role === 'user').length === 1,
            chatInitialId,
            shouldDisableTools: hasTooManyConsecutiveToolFailures(ghostMessages),
            collapsedMessages,
            promptCharacterCounts: characterCounts,
          },
        };
      },
      async onToolCall({ toolCall, addToolOutput }) {
        logger.debug('Starting tool call', toolCall);
        const { result } = await workbenchStore.waitOnToolCall(toolCall.toolCallId);
        logger.debug('Tool call finished', result);
        addToolOutput({
          toolCallId: toolCall.toolCallId,
          output: result,
        });
      },
      autoContinueAfterToolResult: true,
      onError: (e: Error) => {
        captureMessage('Failed to process chat request: ' + e.message, {
          level: 'error',
          extra: {
            error: e,
          },
        });

        const retries = retryState.get();
        logger.error(`Request failed (retries: ${JSON.stringify(retries)})`, e, error);

        const backoff = error?.message.includes(STATUS_MESSAGES.error)
          ? exponentialBackoff(retries.numFailures + 1)
          : 0;
        retryState.set({
          numFailures: retries.numFailures + 1,
          nextRetry: Date.now() + backoff,
        });

        workbenchStore.abortAllActions();
      },
      onFinish: ({ finishReason }) => {
        if (finishReason === 'stop') {
          retryState.set({ numFailures: 0, nextRetry: Date.now() });
        }
        logger.debug('Finished streaming');
      },
    });
    const streamStatus = isRecovering ? 'submitted' : isStreaming ? 'streaming' : status;

    // Reset chat messages when the loaded subchat index changes. We don't want to reset the
    // messages if `initialMessages` changes without a subchat index change.
    useEffect(() => {
      setMessages(initialMessages as UIMessage[]);
      // Reset chat context manager state when switching subchats to prevent stale indices
      chatContextManager.current.reset();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [setMessages, syncState.subchatIndex]);

    const ghostMessages = messages as GhostbuildMessage[];

    // AKA "processed messages," since parsing has side effects
    const { parsedMessages, parseMessages } = useMessageParser(partCache);

    useEffect(() => {
      chatStore.setKey('started', messages.length > 0 || hasMultipleSubchats);
    }, [messages.length, hasMultipleSubchats]);

    useEffect(() => {
      processSampledMessages({
        messages: ghostMessages,
        initialMessages,
        parseMessages,
        storeMessageHistory,
        streamStatus,
      });
    }, [initialMessages, ghostMessages, parseMessages, streamStatus, storeMessageHistory]);

    const abort = () => {
      stop();
      chatStore.setKey('aborted', true);
      workbenchStore.abortAllActions();
    };

    const toolStatus = useCurrentToolStatus();

    const runAnimation = async () => {
      if (chatStarted) {
        return;
      }

      await Promise.all([
        animate('#suggestions', { opacity: 0, display: 'none' }, { duration: 0.1 }),
        animate('#intro', { opacity: 0, flex: 1 }, { duration: 0.2, ease: cubicEasingFn }),
        animate('#footer', { opacity: 0, display: 'none' }, { duration: 0.2 }),
      ]);

      chatStore.setKey('started', true);

      setChatStarted(true);
    };

    const sendMessage = async (messageInput: string) => {
      const now = Date.now();
      const retries = retryState.get();
      if (retries.numFailures >= MAX_RETRIES || now < retries.nextRetry) {
        let message: string | ReactNode = 'Ghostbuild is too busy building right now. ';
        if (retries.numFailures >= MAX_RETRIES) {
          message = <>{message}Please try again later.</>;
        } else {
          const remaining = formatDistanceStrict(now, retries.nextRetry);
          message = (
            <>
              {message}Please try again in {remaining}.
            </>
          );
        }
        toast.error(message);
        captureMessage('User tried to send message but ghostbuild is too busy');
        return;
      }

      if (isStreamStatusActive(streamStatus)) {
        logger.debug('Aborting current message.');
        abort();
        return;
      }

      if (sendMessageInProgress) {
        logger.debug('sendMessage already in progress, returning.');
        return;
      }
      try {
        setSendMessageInProgress(true);

        enableAutoScroll();

        const chatInitialized = await initializeChat();
        if (!chatInitialized) {
          return;
        }

        runAnimation();

        const shouldSendRelevantFiles = chatContextManager.current.shouldSendRelevantFiles(ghostMessages);
        const maybeRelevantFilesMessage: GhostbuildMessage = shouldSendRelevantFiles
          ? chatContextManager.current.relevantFiles(ghostMessages, `${Date.now()}`)
          : {
              id: `${Date.now()}`,
              content: '',
              role: 'user',
              parts: [],
            };

        // Make a clone of the relevantFilesMessage so we can inject the modified message after relevant files before the messageInput later
        const newMessage = structuredClone(maybeRelevantFilesMessage);
        newMessage.parts.push({
          type: 'text',
          text: messageInput,
        });
        newMessage.content = messageInput;
        if (!chatStarted) {
          await sendChatMessage({ parts: toAiSdkMessageParts(newMessage.parts) });
          return;
        }

        const modifiedFiles = workbenchStore.getModifiedFiles();
        chatStore.setKey('aborted', false);
        if (modifiedFiles !== undefined) {
          const userUpdateArtifact = filesToArtifacts(modifiedFiles, `${Date.now()}`);
          maybeRelevantFilesMessage.parts.push({
            type: 'text',
            text: userUpdateArtifact,
          });
          workbenchStore.resetAllFileModifications();
        }
        maybeRelevantFilesMessage.content = messageInput;
        maybeRelevantFilesMessage.parts.push({
          type: 'text',
          text: messageInput,
        });
        await sendChatMessage({ parts: toAiSdkMessageParts(maybeRelevantFilesMessage.parts) });
      } finally {
        setSendMessageInProgress(false);
      }
    };

    const { messageRef, scrollRef, enableAutoScroll } = useSnapScroll();

    return (
      <>
        <BaseChat
          ref={animationScope}
          messageRef={messageRef}
          scrollRef={scrollRef}
          showChat={showChat}
          chatStarted={chatStarted}
          onStop={abort}
          onSend={sendMessage}
          streamStatus={streamStatus}
          isRecovering={isRecovering}
          currentError={error}
          toolStatus={toolStatus}
          messages={parsedMessages /* Note that parsedMessages are throttled. */}
          actionAlert={actionAlert}
          clearAlert={() => workbenchStore.clearAlert()}
          terminalInitializationOptions={terminalInitializationOptions}
          disableChatMessage={null}
          sendMessageInProgress={sendMessageInProgress}
          onRewindToMessage={rewindToMessage}
          subchats={subchats}
        />
      </>
    );
  },
);
AuthenticatedChat.displayName = 'AuthenticatedChat';

function useCurrentToolStatus() {
  const [toolStatus, setToolStatus] = useState<Record<string, ActionStatus>>({});
  useEffect(() => {
    let canceled = false;
    let artifactSubscription: (() => void) | null = null;
    const partSubscriptions: Record<PartId, () => void> = {};
    artifactSubscription = workbenchStore.artifacts.subscribe((artifacts) => {
      if (canceled) {
        return;
      }
      for (const [partId, artifactState] of Object.entries(artifacts)) {
        if (partSubscriptions[partId as PartId]) {
          continue;
        }
        const { actions } = artifactState.runner;
        const sub = actions.subscribe((actionsMap) => {
          setToolStatus((prev) => mergeToolStatus(prev, actionsMap));
        });
        partSubscriptions[partId as PartId] = sub;
      }
    });
    return () => {
      canceled = true;
      artifactSubscription?.();
      for (const sub of Object.values(partSubscriptions)) {
        sub();
      }
    };
  }, []);
  return toolStatus;
}

function mergeToolStatus(current: Record<string, ActionStatus>, actions: Record<string, ActionState>) {
  let next: Record<string, ActionStatus> | undefined;

  for (const [id, action] of Object.entries(actions)) {
    if (current[id] === action.status) {
      continue;
    }

    next ??= { ...current };
    next[id] = action.status;
  }

  return next ?? current;
}

function exponentialBackoff(numFailures: number) {
  const jitter = Math.random() + 0.5;
  const delay = 1000 * Math.pow(2, numFailures) * jitter;
  return delay;
}

function hasTooManyConsecutiveToolFailures(messages: GhostbuildMessage[]) {
  const lastMessage = messages.at(-1);
  if (lastMessage?.role !== 'assistant') {
    return false;
  }

  const toolResults = lastMessage.parts.flatMap((part) => {
    const invocation = getToolInvocation(part);
    return invocation?.state === 'result' ? [invocation] : [];
  });
  if (toolResults.length < MAX_CONSECUTIVE_DEPLOY_ERRORS) {
    return false;
  }

  return toolResults.slice(-MAX_CONSECUTIVE_DEPLOY_ERRORS).every((toolInvocation) => {
    const result =
      typeof toolInvocation.result === 'string' ? toolInvocation.result : JSON.stringify(toolInvocation.result);
    return result.startsWith('Error:');
  });
}
