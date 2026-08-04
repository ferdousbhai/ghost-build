import { lazy, Suspense, type ReactNode } from 'react';
import { messageInputStore } from '~/lib/stores/messageInput';
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

export const STARTER_PROMPTS = [
  {
    label: 'AI support desk',
    prompt:
      'Build an AI support inbox with Cloudflare Workers AI, searchable conversation history, and a clear human handoff flow.',
  },
  {
    label: 'Team launch board',
    prompt: 'Build a collaborative launch board with owners, due dates, realtime presence, and a public progress view.',
  },
  {
    label: 'Customer feedback hub',
    prompt:
      'Build a customer feedback hub with voting, status updates, image attachments, and an internal triage dashboard.',
  },
] as const;

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

            <StarterPrompts
              disabled={disabledReason !== null || isStreaming || sendMessageInProgress}
              onSelect={selectStarterPrompt}
            />
          </div>
        </section>
      </div>
    </div>
  );
}

export function StarterPrompts({ disabled, onSelect }: { disabled: boolean; onSelect: (prompt: string) => void }) {
  return (
    <section className="ghost-home-starters" aria-labelledby="starter-prompts-heading">
      <p id="starter-prompts-heading" className="ghost-home-starters__label">
        Or start with a launch-ready idea
      </p>
      <div className="ghost-home-starters__grid">
        {STARTER_PROMPTS.map(({ label, prompt }) => (
          <button
            key={label}
            type="button"
            className="ghost-home-starter"
            disabled={disabled}
            onClick={() => onSelect(prompt)}
          >
            <span className="ghost-home-starter__title">{label}</span>
            <span className="ghost-home-starter__copy">{prompt}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function selectStarterPrompt(prompt: string) {
  messageInputStore.set(prompt);
  requestAnimationFrame(() => {
    document.querySelector<HTMLTextAreaElement>('.ghost-home-composer-stack textarea')?.focus();
  });
}
