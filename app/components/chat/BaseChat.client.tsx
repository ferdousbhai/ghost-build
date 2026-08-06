import React, { lazy, Suspense, type ReactNode, type RefCallback, useCallback } from 'react';
import { messageText, type GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { isStreamStatusActive, type StreamStatus, type ToolStatus } from '~/lib/common/types';
import { MessageInput } from './MessageInput';
import { Messages } from './Messages.client';
import { useChatId } from '~/lib/stores/chatId';
import { messageInputStore } from '~/lib/stores/messageInput';
import { useUserIdOrNullOrLoading } from '~/lib/stores/userId';
import { classNames } from '~/utils/classNames';
import styles from './BaseChat.module.css';
import { useWorkspaceSwipe } from '~/lib/hooks/useWorkspaceSwipe';
import useViewport from '~/lib/hooks/useViewport';
import { DisabledChatMessageSheet } from './DisabledChatMessageSheet';
import { HomeIntro } from './HomeIntro.client';
import StreamingIndicator from './StreamingIndicator';
import { AnimatePresence, motion, MotionConfig } from 'framer-motion';
import { useStore } from '@nanostores/react';
import { toast } from 'sonner';
import { SubchatBar } from './SubchatBar';
import { refreshSubchats, useMutation } from '~/lib/cloudflare/data-hooks';
import { api } from '~/lib/cloudflare/data-api';
import { subchatIndexStore, useIsSubchatLoaded } from '~/lib/stores/subchats';
import type { BuildProgress } from './build-progress';
import type { SubchatSummary } from './subchat-model';

const Workbench = lazy(() =>
  import('~/components/workbench/Workbench.client').then((module) => ({ default: module.Workbench })),
);
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
  disabledReason: ReactNode | null;
  runtimeNotice: ReactNode;

  // Subchat navigation props
  subchats?: SubchatSummary[];
  onSubchatTitleChange?: (subchatIndex: number, title: string) => void;
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
      toolStatus,
      buildProgress,
      disabledReason,
      runtimeNotice,
      subchats,
      onSubchatTitleChange,
    },
    ref,
  ) => {
    const isStreaming = isRecovering || isStreamStatusActive(streamStatus);
    const currentSubchatIndex = useStore(subchatIndexStore) ?? 0;
    const createSubchat = useMutation(api.subchats.create);
    const setSubchatDescription = useMutation(api.subchats.setDescription);
    const isSubchatLoaded = useIsSubchatLoaded();
    const chatId = useChatId();
    const userId = useUserIdOrNullOrLoading();
    const activeChatContextRef = React.useRef<{ chatId: string; userId: string | null | undefined } | null>(null);
    const createSubchatPendingRef = React.useRef<symbol | null>(null);

    React.useEffect(() => {
      const context = { chatId, userId };
      activeChatContextRef.current = context;
      createSubchatPendingRef.current = null;
      return () => {
        if (activeChatContextRef.current === context) {
          activeChatContextRef.current = null;
        }
        createSubchatPendingRef.current = null;
      };
    }, [chatId, userId]);

    const handleCreateSubchat = useCallback(async (): Promise<boolean> => {
      const context = activeChatContextRef.current;
      if (!userId || context?.chatId !== chatId || context.userId !== userId || createSubchatPendingRef.current) {
        return false;
      }
      const attempt = Symbol('create-subchat');
      createSubchatPendingRef.current = attempt;
      const isActiveChat = () => activeChatContextRef.current === context;
      try {
        let subchatIndex: number;
        try {
          subchatIndex = await createSubchat({ chatId, sessionId: userId });
        } catch (error) {
          if (isActiveChat()) {
            toast.error(error instanceof Error ? error.message : 'Unable to create a new chat.');
          }
          return false;
        }
        if (!isActiveChat()) {
          return true;
        }
        try {
          await refreshSubchats({ chatId, sessionId: userId });
          if (!isActiveChat()) {
            return true;
          }
        } catch (error) {
          if (isActiveChat()) {
            toast.error(
              error instanceof Error
                ? `The chat was created, but its history could not refresh: ${error.message}`
                : 'The chat was created, but its history could not refresh. Reload to continue.',
            );
          }
          return true;
        }
        subchatIndexStore.set(subchatIndex);
        messageInputStore.set('');
        return true;
      } finally {
        if (createSubchatPendingRef.current === attempt) {
          createSubchatPendingRef.current = null;
        }
      }
    }, [createSubchat, chatId, userId]);
    const handleRenameSubchat = useCallback(
      async (title: string): Promise<boolean> => {
        if (!userId) {
          return false;
        }
        try {
          await setSubchatDescription({
            chatId,
            sessionId: userId,
            subchatIndex: currentSubchatIndex,
            description: title,
          });
          await refreshSubchats({ chatId, sessionId: userId });
          return true;
        } catch (error) {
          toast.error(error instanceof Error ? error.message : 'Unable to rename this chat.');
          return false;
        }
      },
      [chatId, currentSubchatIndex, userId, setSubchatDescription],
    );

    const lastUserMessage = messages.findLast((message) => message.role === 'user');
    const resendMessage = useCallback(async () => {
      if (lastUserMessage) {
        await onSend(messageText(lastUserMessage));
      }
    }, [lastUserMessage, onSend]);
    const isSmallViewport = useViewport(1024);
    const swipeEnabled = isSmallViewport && chatStarted;
    const workspaceSwipe = useWorkspaceSwipe(swipeEnabled);
    const content = (
      <div
        ref={ref}
        className={classNames(styles.BaseChat, 'relative flex h-full w-full overflow-hidden')}
        data-chat-visible={showChat}
      >
        <div
          ref={scrollRef}
          className={classNames(styles.ChatScroller, 'flex size-full flex-col overflow-y-auto', {
            'touch-pan-y touch-pinch-zoom': swipeEnabled,
          })}
          {...workspaceSwipe}
        >
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
                      userId={userId ?? null}
                      onSubchatTitleChange={onSubchatTitleChange}
                      handleCreateSubchat={handleCreateSubchat}
                      handleRenameSubchat={handleRenameSubchat}
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
                          <Messages
                            ref={messageRef}
                            className="z-[1] mx-auto flex w-full max-w-chat flex-1 flex-col gap-3 px-3 pb-8 sm:px-0"
                            messages={messages}
                            isStreaming={isStreaming}
                          />
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
                    {runtimeNotice && (
                      <div className="mb-2 px-1 text-xs text-content-tertiary" role="status">
                        {runtimeNotice}
                      </div>
                    )}
                    {(!subchats || (currentSubchatIndex >= subchats.length - 1 && isSubchatLoaded)) && (
                      <>
                        {!disabledReason && (
                          <StreamingIndicator
                            streamStatus={streamStatus}
                            toolStatus={toolStatus}
                            isRecovering={isRecovering}
                            currentError={currentError}
                            buildProgress={buildProgress}
                            isProjectUpdate={currentSubchatIndex > 0}
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
                <Workbench chatStarted isStreaming={isStreaming} />
              </Suspense>
            )}
          </div>
        </div>
      </div>
    );
    return <MotionConfig reducedMotion="user">{content}</MotionConfig>;
  },
);
BaseChat.displayName = 'BaseChat';
