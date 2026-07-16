import { lazy, Suspense, type ReactNode } from 'react';
import type { ActionAlert } from '~/types/actions';
import { MessageInput } from './MessageInput';

const ChatActionAlert = lazy(() => import('./ChatActionAlert').then((module) => ({ default: module.ChatActionAlert })));
const DisabledChatMessageSheet = lazy(() =>
  import('./DisabledChatMessageSheet').then((module) => ({ default: module.DisabledChatMessageSheet })),
);

interface HomeIntroProps {
  actionAlert: ActionAlert | undefined;
  clearAlert: () => void;
  disabledReason: ReactNode | null;
  isStreaming: boolean;
  messagesLength: number;
  onSend: (messageInput: string) => Promise<boolean>;
  onStop: () => void;
  sendMessageInProgress: boolean;
}

export function HomeIntro({
  actionAlert,
  clearAlert,
  disabledReason,
  isStreaming,
  messagesLength,
  onSend,
  onStop,
  sendMessageInProgress,
}: HomeIntroProps) {
  return (
    <div className="ghost-home-shell grow p-4 sm:px-6 lg:px-8 lg:py-5">
      <div className="ghost-home-grid">
        <section className="ghost-home-copy min-w-0" aria-labelledby="intro">
          <div className="ghost-home-reveal">
            <div className="ghost-home-kicker-row">
              <span className="ghost-home-kicker-line" aria-hidden />
              <p className="ghost-home-subeyebrow">Your idea, live on the internet</p>
            </div>
            <h1 id="intro" className="ghost-home-title">
              If you can dream it,
              <br />
              <span>the ghost will build it. ✨</span>
            </h1>
            <p className="ghost-home-lede">Turn a simple prompt into a real, shareable app.</p>
          </div>

          <div className="ghost-home-reveal ghost-home-composer-stack">
            {actionAlert && (
              <Suspense fallback={null}>
                <ChatActionAlert alert={actionAlert} clearAlert={clearAlert} onSend={onSend} />
              </Suspense>
            )}
            <MessageInput
              chatStarted={false}
              isStreaming={isStreaming}
              sendMessageInProgress={sendMessageInProgress}
              disabled={disabledReason !== null}
              onStop={onStop}
              onSend={onSend}
              numMessages={messagesLength}
            />
            {disabledReason && (
              <Suspense fallback={null}>
                <DisabledChatMessageSheet message={disabledReason} />
              </Suspense>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
