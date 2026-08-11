import { lazy, Suspense, type ReactNode } from 'react';
import { HomeHeroCopy } from '~/components/HomeHeroCopy';
import { MessageInput } from './MessageInput';

const DisabledChatMessageSheet = lazy(() =>
  import('./DisabledChatMessageSheet').then((module) => ({ default: module.DisabledChatMessageSheet })),
);

interface HomeIntroProps {
  disabledReason: ReactNode | null;
  isStreaming: boolean;
  messagesLength: number;
  onSend: (messageInput: string, onAccepted?: () => void) => Promise<boolean>;
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
      <section className="ghost-home-copy min-w-0" aria-labelledby="intro">
        <HomeHeroCopy headingId="intro" reveal />

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
  );
}
