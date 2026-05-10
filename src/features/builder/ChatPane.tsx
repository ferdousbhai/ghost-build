import { IntroPanel } from './IntroPanel'
import { MessageList } from './MessageList'
import { PromptComposer } from './PromptComposer'
import type { BuilderMessage } from './builderTypes'

type ChatPaneProps = {
  canSubmit: boolean
  hasStarted: boolean
  isPending: boolean
  messages: Array<BuilderMessage>
  planReady: boolean
  prompt: string
  onPromptChange: (prompt: string) => void
  onSubmit: () => void
}

export function ChatPane({
  canSubmit,
  hasStarted,
  isPending,
  messages,
  planReady,
  prompt,
  onPromptChange,
  onSubmit,
}: ChatPaneProps) {
  return (
    <section className={`chat-pane ${hasStarted ? 'is-active' : ''}`}>
      {!hasStarted ? (
        <IntroPanel onSelectSuggestion={onPromptChange} />
      ) : (
        <MessageList
          isPending={isPending}
          messages={messages}
          planReady={planReady}
        />
      )}

      <PromptComposer
        canSubmit={canSubmit}
        hasStarted={hasStarted}
        isPending={isPending}
        prompt={prompt}
        onPromptChange={onPromptChange}
        onSubmit={onSubmit}
      />
    </section>
  )
}
