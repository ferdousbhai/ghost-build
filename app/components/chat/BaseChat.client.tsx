import { Sheet } from '@ui/Sheet';
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
import ChatAlert from './ChatAlert';
import StreamingIndicator from './StreamingIndicator';
import { SuggestionButtons } from './SuggestionButtons';
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
const CompatibilityWarnings = lazy(() =>
  import('~/components/CompatibilityWarnings.client').then((module) => ({ default: module.CompatibilityWarnings })),
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
  onSend: (messageInput: string) => Promise<void>;
  sendMessageInProgress: boolean;

  // Current chat history props
  streamStatus: StreamStatus;
  isRecovering: boolean;
  currentError: Error | undefined;
  toolStatus: ToolStatus;
  messages: GhostbuildMessage[];
  terminalInitializationOptions: TerminalInitializationOptions | undefined;
  disableChatMessage: ReactNode | string | null;

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
                'items-center px-4 sm:px-8 lg:px-12': !chatStarted,
                'pt-4': chatStarted,
              })}
            >
              {!chatStarted && (
                <div id="intro" className="mx-auto mb-7 mt-10 max-w-4xl px-4 text-center md:mt-14 lg:px-0">
                  <p className="text-content-tertiary animate-fadeInFromLoading mb-4 text-sm font-semibold uppercase">
                    Prompt-to-app for the Cloudflare stack
                  </p>
                  <h1 className="animate-fadeInFromLoading text-content-primary mx-auto mb-4 max-w-3xl font-display text-4xl font-black leading-tight md:text-6xl">
                    Build Cloudflare apps from a plain-English brief
                  </h1>
                  <p className="animate-fadeInFromLoading text-content-secondary mx-auto max-w-2xl text-balance font-display text-base font-medium leading-7 [animation-delay:200ms] [animation-fill-mode:backwards] md:text-xl">
                    Generate TanStack Start projects with Workers AI, D1, R2, and Agents already treated as first-class
                    parts of the app.
                  </p>
                </div>
              )}
              <div
                className={classNames('w-full', {
                  'h-full flex flex-col': chatStarted,
                })}
              >
                {chatStarted ? (
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
                ) : null}
                <div
                  className={classNames('flex flex-col w-full max-w-chat mx-auto z-prompt relative', {
                    'sticky bottom-four': chatStarted,
                  })}
                >
                  {actionAlert && (
                    <div className="bg-background-secondary mb-4">
                      <ChatAlert
                        alert={actionAlert}
                        clearAlert={clearAlert}
                        postMessage={(message) => {
                          onSend(message);
                          clearAlert();
                        }}
                      />
                    </div>
                  )}
                  {(!subchats || (currentSubchatIndex >= subchats.length - 1 && isSubchatLoaded)) && (
                    <>
                      {shouldShowNudge && sessionId && (
                        <div className="mb-4">
                          <SubchatLimitNudge messageCount={messages.length} handleCreateSubchat={handleCreateSubchat} />
                        </div>
                      )}

                      {/* StreamingIndicator is now a normal block above the input */}
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
                  <AnimatePresence>
                    {disableChatMessage && (
                      <motion.div
                        initial={{ translateY: '-100%', opacity: 0 }}
                        animate={{ translateY: '0%', opacity: 1 }}
                        exit={{ translateY: '-100%', opacity: 0 }}
                        transition={{ duration: 0.15 }}
                      >
                        <Sheet className="animate-fadeInFromLoading bg-util-accent/10 -mt-2 flex w-full flex-col gap-3 rounded-xl rounded-t-none p-4 shadow backdrop-blur-lg">
                          {disableChatMessage}
                        </Sheet>
                      </motion.div>
                    )}
                  </AnimatePresence>
                  <Suspense fallback={null}>
                    <CompatibilityWarnings />
                  </Suspense>
                </div>
                {!chatStarted && (
                  <SuggestionButtons
                    disabled={disableChatMessage !== null}
                    chatStarted={chatStarted}
                    onSuggestionClick={(suggestion) => {
                      messageInputStore.set(suggestion);
                    }}
                  />
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
          {!chatStarted && (
            <footer
              id="footer"
              className="text-content-tertiary flex w-full flex-col items-center justify-between gap-2 px-4 py-5 text-sm transition-opacity sm:flex-row"
            >
              <a
                href="https://developers.cloudflare.com/workers-ai/"
                className="hover:text-content-primary font-display font-medium transition-colors"
              >
                Built on Cloudflare Workers AI
              </a>
              <div className="flex items-center gap-3 font-display font-medium">
                <p className="flex items-center">
                  For&nbsp;
                  <a
                    href="https://developers.cloudflare.com/"
                    className="hover:text-content-primary transition-colors"
                    aria-label="Cloudflare Developers"
                  >
                    Cloudflare Developers
                  </a>
                </p>
                <hr className="bg-content-tertiary h-5 w-0.5 opacity-20" />
                <p className="flex items-center">
                  Ships&nbsp;with&nbsp;
                  <a
                    href="https://tanstack.com/start"
                    className="hover:text-content-primary transition-colors"
                    aria-label="TanStack Start"
                  >
                    TanStack Start
                  </a>
                </p>
              </div>
            </footer>
          )}
        </div>
      </div>
    );

    return baseChat;
  },
);
BaseChat.displayName = 'BaseChat';
