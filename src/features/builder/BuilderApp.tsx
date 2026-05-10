import { ChatPane } from './ChatPane'
import { PreviewPane } from './PreviewPane'
import { Topbar } from './Topbar'
import { useBuilderSession } from './useBuilderSession'

export function BuilderApp() {
  const {
    canSubmit,
    hasStarted,
    isPending,
    messages,
    plan,
    request,
    submitPrompt,
    updateIdea,
  } = useBuilderSession()

  return (
    <main className="app-shell">
      <Topbar />

      <section className="builder">
        <ChatPane
          canSubmit={canSubmit}
          hasStarted={hasStarted}
          isPending={isPending}
          messages={messages}
          planReady={Boolean(plan)}
          prompt={request.idea}
          onPromptChange={updateIdea}
          onSubmit={submitPrompt}
        />

        <PreviewPane plan={plan} />
      </section>
    </main>
  )
}
