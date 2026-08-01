import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useSnapScroll } from '~/lib/hooks/useSnapScroll';
import { chatStore } from '~/lib/stores/chatId';
import { toolActivityStore } from '~/lib/stores/tool-activity.client';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { BaseChat } from './BaseChat.client';
import { toast } from 'sonner';
import { chatIdStore, initialIdStore } from '~/lib/stores/chatId';
import { executeDataOperation } from '~/lib/cloudflare/client';
import { api } from '~/lib/cloudflare/data-api';
import { useSessionIdOrNullOrLoading } from '~/lib/stores/sessionId';
import type { ChatProps } from './chat-types';
import { UnauthenticatedChat } from './UnauthenticatedChat';
import { useBuilderAgentChat } from './useBuilderAgentChat';
import { useChatHistoryProcessing } from './useChatHistoryProcessing';
import { useCurrentToolStatus } from './useCurrentToolStatus';
import { useBuildProgress } from './useBuildProgress';
import { appendPendingUserMessage, useChatMessageSubmission } from './useChatMessageSubmission';
import { deriveProvisionalTitle } from '@summonghost/title-generation';
import { subchatIndexStore } from '~/lib/stores/subchats';
import { applyLiveSubchatTitle, type LiveSubchatTitle } from './subchat-model';

const logger = createScopedLogger('Chat');

export const Chat = memo(
  ({
    initialMessages,
    partCache,
    storeMessageHistory,
    initializeChat,
    discardEmptyChat,
    onBuilderRequestStart,
    subchats,
    initialPrompt,
    transcript,
    seedTranscript,
  }: ChatProps) => {
    const [pendingInitialMessage, setPendingInitialMessage] = useState<string | null>(initialPrompt ?? null);
    const clearPendingInitialMessage = useCallback(() => setPendingInitialMessage(null), []);
    const sessionId = useSessionIdOrNullOrLoading();
    if (typeof sessionId !== 'string') {
      return (
        <UnauthenticatedChat
          initialMessages={initialMessages}
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
        discardEmptyChat={discardEmptyChat}
        onBuilderRequestStart={onBuilderRequestStart}
        subchats={subchats}
        pendingInitialMessage={pendingInitialMessage}
        clearPendingInitialMessage={clearPendingInitialMessage}
        transcript={transcript}
        seedTranscript={seedTranscript}
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
    discardEmptyChat,
    onBuilderRequestStart,
    subchats,
    pendingInitialMessage,
    clearPendingInitialMessage,
    transcript,
    seedTranscript,
  }: Omit<ChatProps, 'isReload' | 'hadSuccessfulDeploy'> & {
    pendingInitialMessage: string | null;
    clearPendingInitialMessage: () => void;
  }) => {
    const sessionId = useSessionIdOrNullOrLoading();
    const chatInitialId = useStore(initialIdStore);
    const currentSubchatIndex = useStore(subchatIndexStore) ?? 0;
    const hasMultipleSubchats = (subchats?.length ?? 0) > 1;
    const [liveSubchatTitle, setLiveSubchatTitle] = useState<LiveSubchatTitle | null>(null);
    const handleSubchatTitleChange = useCallback(
      (subchatIndex: number, title: string) => setLiveSubchatTitle({ subchatIndex, title }),
      [],
    );
    const [chatStarted, setChatStarted] = useState(
      initialMessages.length > 0 || hasMultipleSubchats || pendingInitialMessage !== null,
    );
    const disabledReason = null;

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
      transcriptCheckpoint,
      validationStage,
      workspacePresentationState,
    } = useBuilderAgentChat({
      chatInitialId,
      initialMessages,
      onSubchatTitle: handleSubchatTitleChange,
      transcript,
      seedTranscript,
    });
    const parsedMessages = useChatHistoryProcessing({
      messages,
      initialMessages,
      partCache,
      streamStatus,
      storeMessageHistory,
      transcriptCheckpoint,
    });

    useEffect(() => {
      chatStore.setKey('started', chatStarted);
    }, [chatStarted]);

    const abort = () => {
      stop();
      chatStore.setKey('aborted', true);
      toolActivityStore.abortActive();
    };

    const { toolStatus, activeToolNames, activityRevision } = useCurrentToolStatus();
    const buildProgress = useBuildProgress({
      streamStatus,
      isRecovering,
      isProjectUpdate: currentSubchatIndex > 0,
      activeToolNames,
      validationStage,
      toolActivityRevision: activityRevision,
      messages,
    });

    const startChat = () => {
      if (chatStarted) {
        return;
      }
      chatStore.setKey('started', true);
      setChatStarted(true);
    };

    const { messageRef, scrollRef, enableAutoScroll } = useSnapScroll();
    const { pendingUserMessage, sendMessage, sendMessageInProgress } = useChatMessageSubmission({
      messages,
      contextManager,
      chatStarted,
      streamStatus,
      initializeChat,
      discardEmptyChat,
      sendChatMessage,
      enableAutoScroll,
      onAbort: abort,
      onStartChat: startChat,
      onFirstPrompt: (prompt) => {
        const title = deriveProvisionalTitle(prompt);
        if (title) {
          handleSubchatTitleChange(currentSubchatIndex, title);
        }
      },
      onBuilderRequestStart,
      pendingMessage: pendingInitialMessage,
      clearPendingMessage: clearPendingInitialMessage,
    });
    const visibleMessages = useMemo(
      () => appendPendingUserMessage(parsedMessages, pendingUserMessage),
      [parsedMessages, pendingUserMessage],
    );
    const visibleSubchats = useMemo(
      () => applyLiveSubchatTitle(subchats, liveSubchatTitle, transcript),
      [liveSubchatTitle, subchats, transcript],
    );

    return (
      <BaseChat
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
        buildProgress={buildProgress}
        messages={visibleMessages /* Note that parsedMessages are throttled. */}
        disabledReason={disabledReason}
        runtimeNotice={
          workspacePresentationState === 'presentation-error'
            ? 'The code editor could not load. Chat, builds, and remote preview still run from the durable cloud workspace.'
            : workspacePresentationState === 'connecting'
              ? 'Connecting to the durable cloud workspace…'
              : null
        }
        sendMessageInProgress={sendMessageInProgress}
        onRewindToMessage={rewindToMessage}
        subchats={visibleSubchats}
        onSubchatTitleChange={handleSubchatTitleChange}
      />
    );
  },
);
AuthenticatedChat.displayName = 'AuthenticatedChat';
