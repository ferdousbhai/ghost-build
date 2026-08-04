import { lazy, Suspense, type ReactNode } from 'react';
import { HOME_AI_DISCLOSURE } from '~/lib/trust';
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
      <section className="ghost-home-copy min-w-0" aria-labelledby="intro">
        <div className="ghost-home-reveal">
          <p className="ghost-home-beta">Public beta · Cloudflare Computer preview</p>
          <h1 id="intro" className="ghost-home-title">
            If you can dream it,
            <br />
            <span>the ghost will build it. ✨</span>
          </h1>
          <p className="ghost-home-lede">{HOME_AI_DISCLOSURE}</p>
          <p className="ghost-home-ownership">
            Your Cloudflare account owns the workspace, and every production deploy waits for your approval. Requires
            Workers Paid and Containers.
          </p>
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
  );
}
