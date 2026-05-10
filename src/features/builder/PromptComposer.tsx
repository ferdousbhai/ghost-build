import { ArrowUp, Loader2, LockKeyhole } from 'lucide-react'

type PromptComposerProps = {
  canSubmit: boolean
  hasStarted: boolean
  isPending: boolean
  prompt: string
  onPromptChange: (prompt: string) => void
  onSubmit: () => void
}

export function PromptComposer({
  canSubmit,
  hasStarted,
  isPending,
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
            Cloudflare account actions require approval
          </div>
          <button
            aria-label="Run Ghost Coder"
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
