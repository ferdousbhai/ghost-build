import { useStore } from '@nanostores/react';
import { useAnimate } from 'framer-motion';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useSnapScroll } from '~/lib/hooks/useSnapScroll';
import { chatStore } from '~/lib/stores/chatId';
import { workbenchStore } from '~/lib/stores/workbench.client';
import { cubicEasingFn } from '~/utils/easings';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { BaseChat } from './BaseChat.client';
import { toast } from 'sonner';
import { chatIdStore, initialIdStore } from '~/lib/stores/chatId';
import { executeDataOperation } from '~/lib/cloudflare/client';
import { api } from '~/lib/cloudflare/data-api';
import { sessionIdStore, useSessionIdOrNullOrLoading } from '~/lib/stores/sessionId';
import { getOrCreateGuestSessionId } from '~/lib/guest-session';
import { ContainerBootState, useContainerBootState } from '~/lib/stores/containerBootState';
import { UnsupportedRuntimeNotice } from '~/components/UnsupportedRuntime';
import type { ChatProps } from './chat-types';
import { useChatSessionId } from './useChatSessionId';
import { UnauthenticatedChat } from './UnauthenticatedChat';
import { useBuilderAgentChat } from './useBuilderAgentChat';
import { createTerminalInitializationOptions } from './terminal-initialization';
import { useChatHistoryProcessing } from './useChatHistoryProcessing';
import { useCurrentToolStatus } from './useCurrentToolStatus';
import { useChatMessageSubmission } from './useChatMessageSubmission';

const logger = createScopedLogger('Chat');

export const Chat = memo(
  ({
    initialMessages,
    partCache,
    storeMessageHistory,
    initializeChat,
    isReload,
    hadSuccessfulDeploy,
    subchats,
    allowGuest = false,
    initialPrompt,
    resetMessagesOnSubchatChange = true,
  }: ChatProps) => {
    const [pendingGuestMessage, setPendingGuestMessage] = useState<string | null>(initialPrompt ?? null);
    const startGuestSessionWithMessage = useCallback((message: string) => {
      sessionIdStore.set(getOrCreateGuestSessionId());
      setPendingGuestMessage(message);
    }, []);
    const clearPendingGuestMessage = useCallback(() => setPendingGuestMessage(null), []);
    const sessionId = useChatSessionId(allowGuest);
    if (typeof sessionId !== 'string') {
      return (
        <UnauthenticatedChat
          initialMessages={initialMessages}
          isReload={isReload}
          hadSuccessfulDeploy={hadSuccessfulDeploy}
          subchats={subchats}
          authLoading={sessionId === undefined}
          allowGuest={allowGuest}
          onGuestSend={startGuestSessionWithMessage}
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
        pendingGuestMessage={pendingGuestMessage}
        clearPendingGuestMessage={clearPendingGuestMessage}
        resetMessagesOnSubchatChange={resetMessagesOnSubchatChange}
      />
    );
  },
);
Chat.displayName = 'Chat';

const AuthenticatedChat = memo(
  ({
    initialMessages,
    partCache,
    storeMessageHistory,
    initializeChat,
    isReload,
    hadSuccessfulDeploy,
    subchats,
    pendingGuestMessage,
    clearPendingGuestMessage,
    resetMessagesOnSubchatChange = true,
  }: ChatProps & { pendingGuestMessage: string | null; clearPendingGuestMessage: () => void }) => {
    const sessionId = useSessionIdOrNullOrLoading();
    const chatInitialId = useStore(initialIdStore);
    const hasMultipleSubchats = (subchats?.length ?? 0) > 1;
    const [chatStarted, setChatStarted] = useState(initialMessages.length > 0 || hasMultipleSubchats);
    const actionAlert = useStore(workbenchStore.alert);
    const bootState = useContainerBootState();
    const unsupportedRuntimeNotice =
      bootState.state === ContainerBootState.UNSUPPORTED ? (
        <UnsupportedRuntimeNotice experience={bootState.unsupportedExperience} framed={false} />
      ) : null;

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
      () =>
        createTerminalInitializationOptions({
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

    const {
      messages,
      stop,
      sendMessage: sendChatMessage,
      error,
      isRecovering,
      streamStatus,
      contextManager,
    } = useBuilderAgentChat({
      chatInitialId,
      initialMessages,
      resetMessagesOnSubchatChange,
    });
    const parsedMessages = useChatHistoryProcessing({
      messages,
      initialMessages,
      partCache,
      streamStatus,
      storeMessageHistory,
    });

    useEffect(() => {
      chatStore.setKey('started', messages.length > 0 || hasMultipleSubchats);
    }, [messages.length, hasMultipleSubchats]);

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

      const scope = animationScope.current;
      const animations = [
        ['#suggestions', { opacity: 0, display: 'none' }, { duration: 0.1 }],
        ['#intro', { opacity: 0, flex: 1 }, { duration: 0.2, ease: cubicEasingFn }],
        ['#footer', { opacity: 0, display: 'none' }, { duration: 0.2 }],
      ] as const;
      await Promise.all(
        animations.map(([selector, keyframes, options]) => {
          const element = scope?.querySelector(selector);
          return element ? animate(element, keyframes, options) : Promise.resolve();
        }),
      );

      chatStore.setKey('started', true);

      setChatStarted(true);
    };

    const { messageRef, scrollRef, enableAutoScroll } = useSnapScroll();
    const { sendMessage, sendMessageInProgress } = useChatMessageSubmission({
      messages,
      contextManager,
      chatStarted,
      streamStatus,
      runtimeSupported: bootState.state !== ContainerBootState.UNSUPPORTED,
      initializeChat,
      sendChatMessage,
      enableAutoScroll,
      onAbort: abort,
      onStartChat: runAnimation,
      pendingMessage: pendingGuestMessage,
      clearPendingMessage: clearPendingGuestMessage,
    });

    return (
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
        disabledReason={unsupportedRuntimeNotice}
        sendMessageInProgress={sendMessageInProgress}
        onRewindToMessage={rewindToMessage}
        subchats={subchats}
      />
    );
  },
);
AuthenticatedChat.displayName = 'AuthenticatedChat';
