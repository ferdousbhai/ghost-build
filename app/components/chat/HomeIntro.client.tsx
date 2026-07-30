import { lazy, Suspense, type ReactNode } from 'react';
import { MessageInput } from './MessageInput';

const DisabledChatMessageSheet = lazy(() =>
  import('./DisabledChatMessageSheet').then((module) => ({ default: module.DisabledChatMessageSheet })),
);

interface HomeIntroProps {
  disabledReason: ReactNode | null;
  isStreaming: boolean;
  messagesLength: number;
  onSend: (messageInput: string) => Promise<boolean>;
  onStop: () => void;
  sendMessageInProgress: boolean;
}

export function HomeIntro({
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
            <h1 id="intro" className="ghost-home-title">
              If you can dream it,
              <br />
              <span>the ghost will build it. ✨</span>
            </h1>
            <p className="ghost-home-lede">Turn a simple prompt into a real, shareable Cloudflare project.</p>
          </div>

          <div className="ghost-home-reveal ghost-home-composer-stack">
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
