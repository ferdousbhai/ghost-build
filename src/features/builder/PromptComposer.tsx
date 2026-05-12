import { ArrowUp, Loader2, LockKeyhole } from 'lucide-react'
import type { AgentPlanRequest } from '#/lib/agent'
import type { CodexAuthState } from '#/lib/model-auth'

type PromptComposerProps = {
  canSubmit: boolean
  codexAuthState: CodexAuthState
  hasCodexSignIn: boolean
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
  codexAuthState,
  hasCodexSignIn,
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
              codexAuthState,
              hasCodexSignIn,
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
  codexAuthState: CodexAuthState,
  hasCodexSignIn: boolean,
) {
  if (codexAuthState.status === 'unsupported') {
    return `Reconnect ChatGPT/Codex; account metadata is incomplete for ${model}`
  }

  return hasCodexSignIn
    ? `${model} via ${connectedCodexEmail(codexAuthState)}, ${reasoningEffort} reasoning`
    : `Connect ChatGPT/Codex for ${model}, ${reasoningEffort} reasoning`
}

function connectedCodexEmail(authState: CodexAuthState) {
  return authState.account?.email ?? 'ChatGPT/Codex'
}
