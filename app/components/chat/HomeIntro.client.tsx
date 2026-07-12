import { lazy, Suspense, type ReactNode } from 'react';
import type { ActionAlert } from '~/types/actions';
import { MessageInput } from './MessageInput';

const ChatActionAlert = lazy(() => import('./ChatActionAlert').then((module) => ({ default: module.ChatActionAlert })));
const DisabledChatMessageSheet = lazy(() =>
  import('./DisabledChatMessageSheet').then((module) => ({ default: module.DisabledChatMessageSheet })),
);

const buildSignals = [
  { label: 'Routes', value: 'TanStack Start' },
  { label: 'Data', value: 'D1 / R2 / DB' },
  { label: 'Runtime', value: 'Cloudflare Workers' },
  { label: 'Agents', value: 'Workers AI' },
];

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
      <div className="ghost-home-backdrop" aria-hidden />
      <div className="ghost-home-grid">
        <section className="ghost-home-copy min-w-0" aria-labelledby="intro">
          <div className="ghost-home-reveal">
            <div className="ghost-home-kicker-row">
              <span className="ghost-home-mark" aria-hidden>
                <span className="ghost-home-mark__glyph">G</span>
                <span className="ghost-home-mark__spark" />
              </span>
              <div className="ghost-home-kicker-copy">
                <div className="ghost-home-eyebrow">Cloudflare-native app builder</div>
                <div className="ghost-home-subeyebrow">Agents, data, previews, and deploys in one loop</div>
              </div>
            </div>
            <h1 id="intro" className="ghost-home-title">
              Summon a deployed app from one precise brief.
            </h1>
            <p className="ghost-home-lede">
              Ghostbuild turns product intent into routes, data models, agent workflows, previews, and deployable Worker
              projects without leaving the builder.
            </p>
            <ul className="ghost-home-signal-grid" aria-label="Generated app stack">
              {buildSignals.map((signal) => (
                <li className="ghost-home-signal" key={signal.label}>
                  <span>{signal.label}</span>
                  <strong>{signal.value}</strong>
                </li>
              ))}
            </ul>
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

          <div className="ghost-home-preview ghost-home-reveal" aria-label="Ghostbuild generated workspace preview">
            <div className="ghost-home-preview__bar">
              <span className="ghost-home-preview__status" aria-hidden />
              <span>Generated workspace</span>
              <span className="ghost-home-preview__meta">Database / Logs / Preview</span>
            </div>
            <img
              src="/landing/data.png"
              alt="Generated app database workspace with tables and records"
              loading="eager"
              decoding="async"
            />
          </div>
        </section>
      </div>
    </div>
  );
}
