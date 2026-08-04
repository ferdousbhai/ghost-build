import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useSnapScroll } from '~/lib/hooks/useSnapScroll';
import { chatStore } from '~/lib/stores/chatId';
import { toolActivityStore } from '~/lib/stores/tool-activity.client';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { BaseChat } from './BaseChat.client';
import { initialIdStore } from '~/lib/stores/chatId';
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
import { getUserRuntimeSession, userRuntimeEndpointStore } from '~/lib/cloudflare/runtime-session';
import { Loading } from '~/components/Loading';
import { Button } from '@ui/Button';

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
  }: ChatProps) => {
    const [pendingInitialMessage, setPendingInitialMessage] = useState<string | null>(initialPrompt ?? null);
    const clearPendingInitialMessage = useCallback(() => setPendingInitialMessage(null), []);
    const sessionId = useSessionIdOrNullOrLoading();
    const runtimeEndpoint = useStore(userRuntimeEndpointStore);
    const [runtimeConnectionError, setRuntimeConnectionError] = useState<string | null>(null);
    const [runtimeConnectionAttempt, setRuntimeConnectionAttempt] = useState(0);
    useEffect(() => {
      if (typeof sessionId !== 'string' || runtimeEndpoint) {
        return undefined;
      }
      let canceled = false;
      setRuntimeConnectionError(null);
      void getUserRuntimeSession().catch((error) => {
        if (!canceled) {
          logger.error('Unable to connect to the user-owned runtime', error);
          setRuntimeConnectionError(
            error instanceof Error ? error.message : 'Unable to connect to your Cloudflare workspace.',
          );
        }
      });
      return () => {
        canceled = true;
      };
    }, [runtimeConnectionAttempt, runtimeEndpoint, sessionId]);
    if (typeof sessionId !== 'string') {
      return (
        <UnauthenticatedChat
          initialMessages={initialMessages}
          subchats={subchats}
          authLoading={sessionId === undefined}
        />
      );
    }
    if (!runtimeEndpoint) {
      return runtimeConnectionError ? (
        <WorkspaceRuntimeConnectionError
          message={runtimeConnectionError}
          onRetry={() => setRuntimeConnectionAttempt((attempt) => attempt + 1)}
        />
      ) : (
        <Loading message="Connecting to your Cloudflare workspace…" />
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
      />
    );
  },
);
Chat.displayName = 'Chat';

function WorkspaceRuntimeConnectionError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-5">
      <section className="app-card w-full max-w-lg p-6 text-center" aria-labelledby="workspace-connection-heading">
        <p className="app-page-eyebrow">Workspace unavailable</p>
        <h1 id="workspace-connection-heading" className="mt-2 font-display text-3xl font-black text-content-primary">
          Ghostbuild could not connect to your project workspace.
        </h1>
        <p className="mt-3 break-words text-sm text-content-secondary" role="alert">
          {message}
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Button onClick={onRetry}>Try again</Button>
          <Button href="/settings#cloudflare" variant="neutral">
            Check Cloudflare settings
          </Button>
        </div>
      </section>
    </div>
  );
}

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
  }: Omit<ChatProps, 'isReload' | 'hadSuccessfulDeploy'> & {
    pendingInitialMessage: string | null;
    clearPendingInitialMessage: () => void;
  }) => {
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

    const { showChat } = useStore(chatStore);

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
        subchats={visibleSubchats}
        onSubchatTitleChange={handleSubchatTitleChange}
      />
    );
  },
);
AuthenticatedChat.displayName = 'AuthenticatedChat';
