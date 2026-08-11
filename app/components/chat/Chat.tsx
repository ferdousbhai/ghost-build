import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { useSnapScroll } from '~/lib/hooks/useSnapScroll';
import { chatStore } from '~/lib/stores/chatId';
import { toolActivityStore } from '~/lib/stores/tool-activity.client';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { BaseChat } from './BaseChat.client';
import { useChatId } from '~/lib/stores/chatId';
import { useUserIdOrNullOrLoading } from '~/lib/stores/userId';
import type { ChatProps } from './chat-types';
import { UnauthenticatedChat } from './UnauthenticatedChat';
import { workspacePresentationId, useBuilderAgentChat } from './useBuilderAgentChat';
import { useChatHistoryProcessing } from './useChatHistoryProcessing';
import { useCurrentToolStatus } from './useCurrentToolStatus';
import { useBuildProgress } from './useBuildProgress';
import { appendPendingUserMessage, useChatMessageSubmission } from './useChatMessageSubmission';
import { deriveProvisionalTitle } from '@summonghost/title-generation';
import { subchatIndexStore } from '~/lib/stores/subchats';
import { applyLiveSubchatTitle, type LiveSubchatTitle } from './subchat-model';
import {
  getUserRuntimeSession,
  UserRuntimeSessionError,
  userRuntimeEndpointStore,
  type UserRuntimeErrorCode,
} from '~/lib/cloudflare/runtime-session';
import { Loading } from '~/components/Loading';
import { Button } from '@ui/Button';
import { LinkButton } from '~/components/ui/LinkButton';
import { buttonClassNames } from '~/components/ui/primitives/Button';
import { workbenchStore } from '~/lib/stores/workbench.client';
import { WORKERS_PAID_URL } from '~/lib/workers-paid.client';

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
    const userId = useUserIdOrNullOrLoading();
    const runtimeEndpoint = useStore(userRuntimeEndpointStore);
    const [runtimeConnectionError, setRuntimeConnectionError] = useState<{
      message: string;
      code: UserRuntimeErrorCode | null;
    } | null>(null);
    const [runtimeConnectionAttempt, setRuntimeConnectionAttempt] = useState(0);
    useEffect(() => {
      if (typeof userId !== 'string' || runtimeEndpoint) {
        return undefined;
      }
      let canceled = false;
      setRuntimeConnectionError(null);
      void getUserRuntimeSession().catch((error) => {
        if (!canceled) {
          logger.error('Unable to connect to the user-owned runtime', error);
          setRuntimeConnectionError({
            message: error instanceof Error ? error.message : 'Unable to connect to your Cloudflare workspace.',
            code: error instanceof UserRuntimeSessionError ? error.code : null,
          });
        }
      });
      return () => {
        canceled = true;
      };
    }, [runtimeConnectionAttempt, runtimeEndpoint, userId]);
    if (typeof userId !== 'string') {
      return (
        <UnauthenticatedChat initialMessages={initialMessages} subchats={subchats} authLoading={userId === undefined} />
      );
    }
    if (!runtimeEndpoint) {
      return runtimeConnectionError ? (
        <WorkspaceRuntimeConnectionError
          message={runtimeConnectionError.message}
          code={runtimeConnectionError.code}
          onRetry={() => setRuntimeConnectionAttempt((attempt) => attempt + 1)}
        />
      ) : (
        <Loading message="Preparing your workspace…" />
      );
    }

    return (
      <AuthenticatedChat
        accountId={userId}
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

function WorkspaceRuntimeConnectionError({
  message,
  code,
  onRetry,
}: {
  message: string;
  code: UserRuntimeErrorCode | null;
  onRetry: () => void;
}) {
  const planRequired = code === 'workspace_plan_required';
  const reauthorizationRequired = code === 'cloudflare_reauthorization_required';
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-5">
      <section className="app-card w-full max-w-lg p-6 text-center" aria-labelledby="workspace-connection-heading">
        <h1 id="workspace-connection-heading" className="font-display text-3xl font-black text-content-primary">
          Ghostbuild could not prepare your workspace.
        </h1>
        <p className="mt-3 break-words text-sm text-content-secondary" role="alert">
          {message}
        </p>
        {planRequired ? (
          <ol className="mx-auto mt-5 max-w-md list-decimal space-y-2 pl-5 text-left text-sm text-content-secondary">
            <li>Open Cloudflare and enable the Workers Paid plan.</li>
            <li>Return to this tab. You do not need to reconnect your account.</li>
            <li>Select “Try again” to finish creating the workspace.</li>
          </ol>
        ) : null}
        {reauthorizationRequired ? (
          <ol className="mx-auto mt-5 max-w-md list-decimal space-y-2 pl-5 text-left text-sm text-content-secondary">
            <li>Open your Cloudflare account settings below.</li>
            <li>Reauthorize Ghostbuild and approve the updated permissions.</li>
            <li>Return to the builder and select “Try again”.</li>
          </ol>
        ) : null}
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          {planRequired ? (
            <a
              className={buttonClassNames({ variant: 'primary', size: 'md' })}
              href={WORKERS_PAID_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open Workers plan
            </a>
          ) : null}
          <Button variant={planRequired ? 'neutral' : 'primary'} onClick={onRetry}>
            Try again
          </Button>
          <LinkButton to="/settings" hash="cloudflare" variant={reauthorizationRequired ? 'primary' : 'neutral'}>
            {reauthorizationRequired ? 'Reauthorize Cloudflare' : 'Cloudflare account'}
          </LinkButton>
        </div>
      </section>
    </div>
  );
}

const AuthenticatedChat = memo(
  ({
    accountId,
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
  }: ChatProps & {
    accountId: string;
    pendingInitialMessage: string | null;
    clearPendingInitialMessage: () => void;
  }) => {
    const chatInitialId = useChatId();
    const presentationId = workspacePresentationId(accountId, transcript.agentName);
    useLayoutEffect(() => {
      workbenchStore.activateWorkspace(presentationId);
      toolActivityStore.activateScope(presentationId);
    }, [presentationId]);
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
      deploymentApproval,
      deploymentReady,
      prepareDeployment,
      workspacePresentationState,
    } = useBuilderAgentChat({
      accountId,
      chatInitialId,
      initialMessages,
      onSubchatTitle: handleSubchatTitleChange,
      presentationId,
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
      return () => {
        chatStore.set({ started: false, aborted: false, showChat: true });
      };
    }, [chatStarted]);

    const abort = () => {
      stop();
      chatStore.setKey('aborted', true);
      toolActivityStore.abortActive();
    };

    const { activeToolNames, activityRevision } = useCurrentToolStatus(messages);
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
        buildProgress={buildProgress}
        messages={visibleMessages /* Note that parsedMessages are throttled. */}
        disabledReason={disabledReason}
        deploymentApproval={deploymentApproval}
        onPrepareDeployment={deploymentReady ? prepareDeployment : undefined}
        runtimeNotice={
          workspacePresentationState === 'presentation-error'
            ? 'Editor unavailable. Chat, builds, and previews still work.'
            : workspacePresentationState === 'connecting'
              ? 'Loading project files…'
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
