import React, { lazy, Suspense, type ReactNode, type RefCallback, useCallback } from 'react';
import { messageText, type GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { isStreamStatusActive, type StreamStatus, type ToolStatus } from '~/lib/common/types';
import type { TerminalInitializationOptions } from '~/types/terminal';
import { MessageInput } from './MessageInput';
import { useChatId } from '~/lib/stores/chatId';
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
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { SubchatBar } from './SubchatBar';
import { SubchatLimitNudge } from './SubchatLimitNudge';
import { subchatQueryKey, useMutation } from '~/lib/cloudflare/data-hooks';
import { api } from '~/lib/cloudflare/data-api';
import { subchatIndexStore, useIsSubchatLoaded } from '~/lib/stores/subchats';
import type { BuildProgress } from './build-progress';
import type { SubchatSummary } from './subchat-model';

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
  onSend: (messageInput: string) => Promise<boolean>;
  sendMessageInProgress: boolean;

  // Current chat history props
  streamStatus: StreamStatus;
  isRecovering: boolean;
  currentError: Error | undefined;
  toolStatus: ToolStatus;
  buildProgress: BuildProgress | null;
  messages: GhostbuildMessage[];
  terminalInitializationOptions: TerminalInitializationOptions | undefined;
  disabledReason: ReactNode | null;

  // Alert related props
  actionAlert: ActionAlert | undefined;
  clearAlert: () => void;

  // Rewind functionality
  onRewindToMessage?: (subchatIndex?: number, messageIndex?: number) => void;

  // Subchat navigation props
  subchats?: SubchatSummary[];
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
      buildProgress,
      terminalInitializationOptions,
      disabledReason,
      onRewindToMessage,
      subchats,
    },
    ref,
  ) => {
    const isStreaming = isRecovering || isStreamStatusActive(streamStatus);
    const currentSubchatIndex = useStore(subchatIndexStore) ?? 0;
    const shouldShowNudge = messages.length > MIN_MESSAGES_FOR_SUBCHAT_NUDGE;
    const createSubchat = useMutation(api.subchats.create);
    const queryClient = useQueryClient();
    const isSubchatLoaded = useIsSubchatLoaded();
    const createSubchatPendingRef = React.useRef(false);

    const chatId = useChatId();
    const sessionId = useSessionIdOrNullOrLoading();
    const handleCreateSubchat = useCallback(async (): Promise<boolean> => {
      if (!sessionId || createSubchatPendingRef.current) {
        return false;
      }
      createSubchatPendingRef.current = true;
      try {
        let subchatIndex: number;
        try {
          subchatIndex = await createSubchat({ chatId, sessionId });
        } catch (error) {
          toast.error(error instanceof Error ? error.message : 'Unable to create a new chat.');
          return false;
        }
        try {
          await queryClient.invalidateQueries({
            queryKey: subchatQueryKey({ chatId, sessionId }),
          });
        } catch (error) {
          toast.error(
            error instanceof Error
              ? `The chat was created, but its history could not refresh: ${error.message}`
              : 'The chat was created, but its history could not refresh. Reload to continue.',
          );
        }
        subchatIndexStore.set(subchatIndex);
        messageInputStore.set('');
        return true;
      } finally {
        createSubchatPendingRef.current = false;
      }
    }, [createSubchat, chatId, queryClient, sessionId]);

    const lastUserMessage = messages.findLast((message) => message.role === 'user');
    const resendMessage = useCallback(async () => {
      if (lastUserMessage) {
        await onSend(messageText(lastUserMessage));
      }
    }, [lastUserMessage, onSend]);
    return (
      <div
        ref={ref}
        className={classNames(styles.BaseChat, 'relative flex h-full w-full overflow-hidden')}
        data-chat-visible={showChat}
      >
        <div ref={scrollRef} className={classNames(styles.ChatScroller, 'flex size-full flex-col overflow-y-auto')}>
          <div className="flex w-full grow flex-col lg:flex-row">
            <div
              className={classNames(styles.Chat, 'flex flex-col flex-grow lg:min-w-[var(--chat-min-width)] h-full', {
                'items-stretch': !chatStarted,
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
                    disabledReason={disabledReason}
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
                      chatDisabled={disabledReason !== null || messages.length === 0}
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
                          className={classNames(styles.Conversation, 'mx-auto flex w-full max-w-chat flex-1 flex-col')}
                        >
                          <Suspense fallback={null}>
                            <Messages
                              ref={messageRef}
                              className="z-[1] mx-auto flex w-full max-w-chat flex-1 flex-col gap-3 px-3 pb-8 sm:px-0"
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
                  <div
                    className={classNames(
                      styles.ComposerDock,
                      'z-prompt sticky bottom-0 mx-auto flex w-full max-w-chat flex-col px-3 pb-3 sm:px-0 sm:pb-4',
                    )}
                  >
                    <ChatActionAlert
                      alert={actionAlert}
                      clearAlert={clearAlert}
                      onSend={onSend}
                      className="mb-4 bg-background-secondary"
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

                        {!disabledReason && (
                          <StreamingIndicator
                            streamStatus={streamStatus}
                            numMessages={messages.length}
                            numSubchats={subchats?.length ?? 1}
                            toolStatus={toolStatus}
                            isRecovering={isRecovering}
                            currentError={currentError}
                            buildProgress={buildProgress}
                            submissionPending={sendMessageInProgress}
                            onStop={onStop}
                            resendMessage={resendMessage}
                          />
                        )}

                        <MessageInput
                          chatStarted={chatStarted}
                          isStreaming={isStreaming}
                          sendMessageInProgress={sendMessageInProgress}
                          disabled={disabledReason !== null}
                          onStop={onStop}
                          onSend={onSend}
                          numMessages={messages.length}
                        />
                      </>
                    )}
                    <DisabledChatMessageSheet message={disabledReason} />
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
  },
);
BaseChat.displayName = 'BaseChat';
