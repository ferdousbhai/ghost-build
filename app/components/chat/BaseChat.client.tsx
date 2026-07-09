import React, { lazy, Suspense, type ReactNode, type RefCallback, useCallback, useMemo } from 'react';
import { messageText, type GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { isStreamStatusActive, type StreamStatus, type ToolStatus } from '~/lib/common/types';
import type { TerminalInitializationOptions } from '~/types/terminal';
import { MessageInput } from './MessageInput';
import { useChatId } from '~/lib/stores/chatId';
import { getCloudflareSiteUrl } from '~/lib/cloudflareSiteUrl';
import { messageInputStore } from '~/lib/stores/messageInput';
import { useSessionIdOrNullOrLoading } from '~/lib/stores/sessionId';
import type { ActionAlert } from '~/types/actions';
import { classNames } from '~/utils/classNames';
import styles from './BaseChat.module.css';
import { ChatActionAlert } from './ChatActionAlert';
import { DisabledChatMessageSheet } from './DisabledChatMessageSheet';
import { HomeIntro } from './HomeIntro.client';
import StreamingIndicator from './StreamingIndicator';
import { AnimatePresence, motion } from 'framer-motion';
import { useStore } from '@nanostores/react';
import { SubchatBar } from './SubchatBar';
import { SubchatLimitNudge } from './SubchatLimitNudge';
import { useMutation } from '~/lib/cloudflare/data-hooks';
import { api } from '~/lib/cloudflare/data-api';
import { subchatIndexStore, useIsSubchatLoaded } from '~/lib/stores/subchats';

const MIN_MESSAGES_FOR_SUBCHAT_NUDGE = 12;
const Workbench = lazy(() =>
  import('~/components/workbench/Workbench.client').then((module) => ({ default: module.Workbench })),
);
const Messages = lazy(() => import('./Messages.client').then((module) => ({ default: module.Messages })));

interface BaseChatProps {
  // Refs
  messageRef: RefCallback<HTMLDivElement> | undefined;
  scrollRef: RefCallback<HTMLDivElement> | undefined;

  // Top-level chat props
  showChat: boolean;
  chatStarted: boolean;

  // Chat user interactions
  onStop: () => void;
  onSend: (messageInput: string) => Promise<void>;
  sendMessageInProgress: boolean;

  // Current chat history props
  streamStatus: StreamStatus;
  isRecovering: boolean;
  currentError: Error | undefined;
  toolStatus: ToolStatus;
  messages: GhostbuildMessage[];
  terminalInitializationOptions: TerminalInitializationOptions | undefined;
  disableChatMessage: ReactNode | null;

  // Alert related props
  actionAlert: ActionAlert | undefined;
  clearAlert: () => void;

  // Rewind functionality
  onRewindToMessage?: (subchatIndex?: number, messageIndex?: number) => void;

  // Subchat navigation props
  subchats?: { subchatIndex: number; updatedAt: number; description?: string }[];
}

export const BaseChat = React.forwardRef<HTMLDivElement, BaseChatProps>(
  (
    {
      messageRef,
      scrollRef,
      showChat = true,
      chatStarted = false,
      streamStatus = 'ready',
      currentError,
      onSend,
      onStop,
      sendMessageInProgress,
      messages,
      isRecovering,
      actionAlert,
      clearAlert,
      toolStatus,
      terminalInitializationOptions,
      disableChatMessage,
      onRewindToMessage,
      subchats,
    },
    ref,
  ) => {
    const isStreaming = isRecovering || isStreamStatusActive(streamStatus);
    const currentSubchatIndex = useStore(subchatIndexStore) ?? 0;
    const shouldShowNudge = messages.length > MIN_MESSAGES_FOR_SUBCHAT_NUDGE;
    const createSubchat = useMutation(api.subchats.create);
    const isSubchatLoaded = useIsSubchatLoaded();

    const chatId = useChatId();
    const sessionId = useSessionIdOrNullOrLoading();
    const dataForEvals = useMemo(() => {
      return JSON.stringify({
        chatId,
        sessionId,
        workerSiteUrl: getCloudflareSiteUrl(),
      });
    }, [chatId, sessionId]);

    const handleCreateSubchat = useCallback(async () => {
      if (!sessionId) {
        return;
      }
      const subchatIndex = await createSubchat({ chatId, sessionId });
      subchatIndexStore.set(subchatIndex);
      messageInputStore.set('');
    }, [createSubchat, chatId, sessionId]);

    const lastUserMessage = messages.findLast((message) => message.role === 'user');
    const resendMessage = useCallback(async () => {
      if (lastUserMessage) {
        await onSend(messageText(lastUserMessage));
      }
    }, [lastUserMessage, onSend]);
    const baseChat = (
      <div
        ref={ref}
        className={classNames(styles.BaseChat, 'relative flex h-full w-full overflow-hidden')}
        data-chat-visible={showChat}
        data-messages-for-evals={dataForEvals}
      >
        <div ref={scrollRef} className="flex size-full flex-col overflow-y-auto">
          <div className="flex w-full grow flex-col lg:flex-row">
            <div
              className={classNames(styles.Chat, 'flex flex-col flex-grow lg:min-w-[var(--chat-min-width)] h-full', {
                'items-stretch': !chatStarted,
                'pt-4': chatStarted,
              })}
            >
              <div
                className={classNames('w-full', {
                  'h-full flex flex-col': chatStarted,
                })}
              >
                {!chatStarted ? (
                  <HomeIntro
                    actionAlert={actionAlert}
                    clearAlert={clearAlert}
                    disableChatMessage={disableChatMessage}
                    isStreaming={isStreaming}
                    messagesLength={messages.length}
                    onSend={onSend}
                    onStop={onStop}
                    sendMessageInProgress={sendMessageInProgress}
                  />
                ) : (
                  <>
                    <SubchatBar
                      subchats={subchats}
                      currentSubchatIndex={currentSubchatIndex}
                      isStreaming={isStreaming}
                      disableChatMessage={disableChatMessage !== null || messages.length === 0}
                      sessionId={sessionId ?? null}
                      onRewind={onRewindToMessage}
                      handleCreateSubchat={handleCreateSubchat}
                      isSubchatLoaded={isSubchatLoaded}
                    />

                    {isSubchatLoaded && (
                      <AnimatePresence>
                        <motion.div
                          key="messages"
                          initial={{ opacity: 0, y: 20 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -20 }}
                          transition={{ duration: 0.3, ease: 'easeInOut' }}
                          className="mx-auto flex w-full max-w-chat flex-1 flex-col"
                        >
                          <Suspense fallback={null}>
                            <Messages
                              ref={messageRef}
                              className="z-[1] mx-auto flex w-full max-w-chat flex-1 flex-col gap-4 pb-6"
                              messages={messages}
                              isStreaming={isStreaming}
                              onRewindToMessage={onRewindToMessage}
                              subchatsLength={subchats?.length}
                            />
                          </Suspense>
                        </motion.div>
                      </AnimatePresence>
                    )}
                  </>
                )}
                {chatStarted && (
                  <div className="z-prompt bottom-four sticky mx-auto flex w-full max-w-chat flex-col">
                    <ChatActionAlert
                      alert={actionAlert}
                      clearAlert={clearAlert}
                      onSend={onSend}
                      className="bg-background-secondary mb-4"
                    />
                    {(!subchats || (currentSubchatIndex >= subchats.length - 1 && isSubchatLoaded)) && (
                      <>
                        {shouldShowNudge && sessionId && (
                          <div className="mb-4">
                            <SubchatLimitNudge
                              messageCount={messages.length}
                              handleCreateSubchat={handleCreateSubchat}
                            />
                          </div>
                        )}

                        {!disableChatMessage && !shouldShowNudge && (
                          <StreamingIndicator
                            streamStatus={streamStatus}
                            numMessages={messages.length}
                            numSubchats={subchats?.length ?? 1}
                            toolStatus={toolStatus}
                            isRecovering={isRecovering}
                            currentError={currentError}
                            resendMessage={resendMessage}
                          />
                        )}

                        {!shouldShowNudge && (
                          <MessageInput
                            chatStarted={chatStarted}
                            isStreaming={isStreaming}
                            sendMessageInProgress={sendMessageInProgress}
                            disabled={disableChatMessage !== null}
                            onStop={onStop}
                            onSend={onSend}
                            numMessages={messages.length}
                          />
                        )}
                      </>
                    )}
                    <DisabledChatMessageSheet message={disableChatMessage} />
                  </div>
                )}
              </div>
            </div>
            {chatStarted && (
              <Suspense fallback={null}>
                <Workbench
                  chatStarted
                  isStreaming={isStreaming}
                  terminalInitializationOptions={terminalInitializationOptions}
                />
              </Suspense>
            )}
          </div>
        </div>
      </div>
    );

    return baseChat;
  },
);
BaseChat.displayName = 'BaseChat';
