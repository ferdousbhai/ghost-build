import { ArrowUp, Loader2, LockKeyhole } from 'lucide-react'
import type { AgentPlanRequest } from '#/lib/agent'
import type { AppAuthState } from '#/lib/model-auth'

type PromptComposerProps = {
  canSubmit: boolean
  appAuthState: AppAuthState
  hasAppSignIn: boolean
  hasStarted: boolean
  isPending: boolean
  model: AgentPlanRequest['model']
  reasoningEffort: AgentPlanRequest['reasoningEffort']
  prompt: string
  onPromptChange: (prompt: string) => void
  onSubmit: () => void
}

export function PromptComposer({
  canSubmit,
  appAuthState,
  hasAppSignIn,
  hasStarted,
  isPending,
  model,
  reasoningEffort,
  prompt,
  onPromptChange,
  onSubmit,
}: PromptComposerProps) {
  return (
    <div className="composer-wrap">
      <div className="composer">
        <textarea
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              onSubmit()
            }
          }}
          placeholder={
            hasStarted
              ? 'Ask for a change, new feature, or deployment step...'
              : 'Describe the app you want to build...'
          }
        />

        <div className="composer-footer">
          <div className="composer-meta">
            <LockKeyhole size={14} />
            {describeModelAuth(
              model,
              reasoningEffort,
              appAuthState,
              hasAppSignIn,
            )}
          </div>
          <button
            aria-label="Run GhostBuild"
            className="send-button"
            type="button"
            disabled={!canSubmit}
            onClick={onSubmit}
          >
            {isPending ? (
              <Loader2 className="animate-spin" size={18} />
            ) : (
              <ArrowUp size={18} />
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

function describeModelAuth(
  model: AgentPlanRequest['model'],
  reasoningEffort: AgentPlanRequest['reasoningEffort'],
  appAuthState: AppAuthState,
  hasAppSignIn: boolean,
) {
  return hasAppSignIn
    ? `${model} via GhostBuild API billing for ${connectedAppEmail(appAuthState)}, ${reasoningEffort} reasoning`
    : `Sign in to GhostBuild for ${model}, ${reasoningEffort} reasoning`
}

function connectedAppEmail(authState: AppAuthState) {
  return authState.account?.email ?? 'signed-in user'
}
