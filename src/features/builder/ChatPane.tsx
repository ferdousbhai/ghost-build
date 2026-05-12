import { IntroPanel } from './IntroPanel'
import { MessageList } from './MessageList'
import { PromptComposer } from './PromptComposer'
import type { AgentPlanRequest } from '#/lib/agent'
import type { StoredBuilderSessionSummary } from '#/lib/builder-session-store'
import type { CodexAuthState } from '#/lib/model-auth'
import type { BuilderMessage } from './builderTypes'

type ChatPaneProps = {
  canSubmit: boolean
  codexAuthState: CodexAuthState
  hasCodexSignIn: boolean
  hasStarted: boolean
  isPending: boolean
  messages: Array<BuilderMessage>
  planReady: boolean
  prompt: string
  activeSessionId?: string
  model: AgentPlanRequest['model']
  projectSource: AgentPlanRequest['projectSource']
  reasoningEffort: AgentPlanRequest['reasoningEffort']
  sessionSummaries: Array<StoredBuilderSessionSummary>
  goal: AgentPlanRequest['goal']
  onPromptChange: (prompt: string) => void
  onGoalObjectiveChange: (objective: string) => void
  onGoalSuccessCriteriaChange: (criteria: string) => void
  onProjectSourceChange: (
    projectSource: AgentPlanRequest['projectSource'],
  ) => void
  onReasoningEffortChange: (
    reasoningEffort: AgentPlanRequest['reasoningEffort'],
  ) => void
  onSelectSession: (sessionId: string) => void
  onSubmit: () => void
}

export function ChatPane({
  canSubmit,
  codexAuthState,
  hasCodexSignIn,
  hasStarted,
  isPending,
  messages,
  planReady,
  prompt,
  activeSessionId,
  model,
  projectSource,
  reasoningEffort,
  sessionSummaries,
  goal,
  onPromptChange,
  onGoalObjectiveChange,
  onGoalSuccessCriteriaChange,
  onProjectSourceChange,
  onReasoningEffortChange,
  onSelectSession,
  onSubmit,
}: ChatPaneProps) {
  return (
    <section className={`chat-pane ${hasStarted ? 'is-active' : ''}`}>
      <SessionList
        activeSessionId={activeSessionId}
        sessions={sessionSummaries}
        onSelectSession={onSelectSession}
      />

      {!hasStarted ? (
        <IntroPanel
          hasCodexSignIn={hasCodexSignIn}
          codexAuthState={codexAuthState}
          model={model}
          projectSource={projectSource}
          reasoningEffort={reasoningEffort}
          goal={goal}
          onGoalObjectiveChange={onGoalObjectiveChange}
          onGoalSuccessCriteriaChange={onGoalSuccessCriteriaChange}
          onProjectSourceChange={onProjectSourceChange}
          onReasoningEffortChange={onReasoningEffortChange}
          onSelectSuggestion={onPromptChange}
        />
      ) : (
        <MessageList
          isPending={isPending}
          messages={messages}
          planReady={planReady}
          goal={goal}
          onGoalObjectiveChange={onGoalObjectiveChange}
          onGoalSuccessCriteriaChange={onGoalSuccessCriteriaChange}
        />
      )}

      <PromptComposer
        canSubmit={canSubmit}
        codexAuthState={codexAuthState}
        hasCodexSignIn={hasCodexSignIn}
        model={model}
        reasoningEffort={reasoningEffort}
        hasStarted={hasStarted}
        isPending={isPending}
        prompt={prompt}
        onPromptChange={onPromptChange}
        onSubmit={onSubmit}
      />
    </section>
  )
}

function SessionList({
  activeSessionId,
  sessions,
  onSelectSession,
}: {
  activeSessionId?: string
  sessions: Array<StoredBuilderSessionSummary>
  onSelectSession: (sessionId: string) => void
}) {
  if (!sessions.length) {
    return null
  }

  return (
    <div className="session-list" aria-label="Saved sessions">
      {sessions.slice(0, 4).map((session) => (
        <button
          type="button"
          key={session.sessionId}
          className={session.sessionId === activeSessionId ? 'is-active' : ''}
          onClick={() => onSelectSession(session.sessionId)}
        >
          <span>{session.status}</span>
          <b>{session.workerName}</b>
        </button>
      ))}
    </div>
  )
}
