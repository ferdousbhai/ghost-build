import type { ReactNode } from 'react';
import type { ActionAlert } from '~/types/actions';
import { ChatActionAlert } from './ChatActionAlert';
import { DisabledChatMessageSheet } from './DisabledChatMessageSheet';
import { MessageInput } from './MessageInput';

interface HomeIntroProps {
  actionAlert: ActionAlert | undefined;
  clearAlert: () => void;
  disableChatMessage: ReactNode | null;
  isStreaming: boolean;
  messagesLength: number;
  onSend: (messageInput: string) => Promise<void>;
  onStop: () => void;
  sendMessageInProgress: boolean;
}

export function HomeIntro({
  actionAlert,
  clearAlert,
  disableChatMessage,
  isStreaming,
  messagesLength,
  onSend,
  onStop,
  sendMessageInProgress,
}: HomeIntroProps) {
  return (
    <div className="ghost-home-shell grow px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
      <div className="ghost-home-grid">
        <section className="ghost-home-copy min-w-0" aria-labelledby="intro">
          <div className="ghost-home-reveal">
            <div className="ghost-home-eyebrow">Cloudflare-native app builder</div>
            <h1 id="intro" className="ghost-home-title">
              Turn your idea into a deployed web app.
            </h1>
            <p className="ghost-home-lede">
              Ghostbuild turns product intent into routes, data, agents, previews, and deployable Worker projects in one
              workspace.
            </p>
          </div>

          <div className="ghost-home-reveal ghost-home-composer-stack">
            <ChatActionAlert alert={actionAlert} clearAlert={clearAlert} onSend={onSend} />
            <MessageInput
              chatStarted={false}
              isStreaming={isStreaming}
              sendMessageInProgress={sendMessageInProgress}
              disabled={disableChatMessage !== null}
              onStop={onStop}
              onSend={onSend}
              numMessages={messagesLength}
            />
            <DisabledChatMessageSheet message={disableChatMessage} />
          </div>
        </section>
      </div>
    </div>
  );
}
