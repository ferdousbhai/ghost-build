import {
  CheckCircle2,
  FolderInput,
  Github,
  LogIn,
  MessageSquarePlus,
  PackagePlus,
  Gauge,
  Sparkles,
} from 'lucide-react'
import type { AgentPlanRequest } from '#/lib/agent'
import { authClient } from '#/lib/auth-client'
import type { AppAuthState } from '#/lib/model-auth'
import { getModelCatalogEntry } from '#/lib/model-catalog'
import { promptSuggestions } from './builderConstants'

type IntroPanelProps = {
  appAuthState: AppAuthState
  hasAppSignIn: boolean
  model: AgentPlanRequest['model']
  projectSource: AgentPlanRequest['projectSource']
  reasoningEffort: AgentPlanRequest['reasoningEffort']
  goal: AgentPlanRequest['goal']
  onGoalObjectiveChange: (objective: string) => void
  onGoalSuccessCriteriaChange: (criteria: string) => void
  onProjectSourceChange: (
    projectSource: AgentPlanRequest['projectSource'],
  ) => void
  onReasoningEffortChange: (
    reasoningEffort: AgentPlanRequest['reasoningEffort'],
  ) => void
  onSelectSuggestion: (suggestion: string) => void
}

const officialStarter = {
  type: 'new',
  starter: 'TanStack Start on Cloudflare Workers',
  command:
    'pnpm create cloudflare@latest my-tanstack-start-app --framework=tanstack-start',
  sourceUrl:
    'https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack-start/',
} as const

export function IntroPanel({
  appAuthState,
  hasAppSignIn,
  model,
  projectSource,
  reasoningEffort,
  goal,
  onGoalObjectiveChange,
  onGoalSuccessCriteriaChange,
  onProjectSourceChange,
  onReasoningEffortChange,
  onSelectSuggestion,
}: IntroPanelProps) {
  const isExisting = projectSource.type !== 'new'
  const modelMetadata = getModelCatalogEntry(model)

  return (
    <div className="intro-panel">
      <div className="intro-icon">
        <Sparkles size={24} />
      </div>
      <h1>What app should GhostBuild build?</h1>
      <p>
        Set the goal for a Cloudflare web app. GhostBuild plans against that
        goal, uses Cloudflare Skills and the Cloudflare API MCP server, then
        works toward preview and deploy.
      </p>

      <div className="project-source" aria-label="Project source">
        <div className="goal-editor">
          <label>
            <span>Active goal</span>
            <textarea
              value={goal?.objective ?? ''}
              placeholder="Build and deploy a Cloudflare web app that..."
              onChange={(event) => onGoalObjectiveChange(event.target.value)}
            />
          </label>
          <label>
            <span>Done when</span>
            <textarea
              value={(goal?.successCriteria ?? []).join('\n')}
              placeholder={[
                'The core workflow works in preview',
                'The app deploys as a Cloudflare Worker',
                'Paid or destructive actions require approval',
              ].join('\n')}
              onChange={(event) =>
                onGoalSuccessCriteriaChange(event.target.value)
              }
            />
          </label>
        </div>

        <div className="source-toggle">
          <button
            type="button"
            className={projectSource.type === 'new' ? 'selected' : ''}
            onClick={() => onProjectSourceChange(officialStarter)}
          >
            <PackagePlus size={18} />
            New project
          </button>
          <button
            type="button"
            className={isExisting ? 'selected' : ''}
            disabled
          >
            <FolderInput size={18} />
            Existing project
          </button>
        </div>

        {projectSource.type === 'new' ? (
          <div className="source-card source-card-new">
            <div>
              <span>Official starter</span>
              <strong>TanStack Start + Query on Cloudflare</strong>
              <code>{projectSource.command}</code>
            </div>
            <a href={projectSource.sourceUrl} target="_blank" rel="noreferrer">
              Docs
            </a>
          </div>
        ) : (
          <div className="existing-options">
            <button type="button" className="selected" disabled>
              <Github size={19} />
              <span>
                <b>GitHub</b>
                Import support is planned after the new-app flow
              </span>
            </button>
          </div>
        )}

        <div className="source-status">
          <CheckCircle2 size={16} />
          {describeSource(projectSource)}
        </div>
      </div>

      <div className="model-access" aria-label="Model authentication">
        <button
          type="button"
          className="selected"
          onClick={async () => {
            if (!hasAppSignIn) {
              await authClient.signIn.social({
                provider: 'google',
                callbackURL: '/',
              })
            }
          }}
        >
          <LogIn size={20} />
          <span>
            <b>GhostBuild sign-in</b>
            {describeAppAccount(appAuthState)}
          </span>
          <em>{hasAppSignIn ? 'Connected' : 'Connect'}</em>
        </button>
        {!hasAppSignIn ? (
          <button
            type="button"
            onClick={() =>
              authClient.signIn.social({
                provider: 'github',
                callbackURL: '/',
              })
            }
          >
            <Github size={20} />
            <span>
              <b>Continue with GitHub</b>
              Use your GitHub account for GhostBuild.
            </span>
            <em>Connect</em>
          </button>
        ) : null}
      </div>

      <div className="model-policy" aria-label="Model policy">
        <div className="model-name">
          <Gauge size={18} />
          <span>
            <b>{model}</b>
            Model
          </span>
        </div>

        <div className="reasoning-control" aria-label="Reasoning effort">
          {modelMetadata.supportedReasoningEfforts.map((effort) => (
            <button
              key={effort}
              type="button"
              className={reasoningEffort === effort ? 'selected' : ''}
              onClick={() => onReasoningEffortChange(effort)}
            >
              {effort}
            </button>
          ))}
        </div>
      </div>

      <div className="suggestions">
        {promptSuggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => onSelectSuggestion(suggestion)}
          >
            <MessageSquarePlus size={16} />
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  )
}

function describeAppAccount(authState: AppAuthState) {
  if (authState.status === 'connected') {
    const email = authState.account?.email ?? 'unknown account'
    return `${email}.`
  }

  return 'Use Google or GitHub to access the builder.'
}

function describeSource(source: AgentPlanRequest['projectSource']) {
  if (source.type === 'new') {
    return 'Ready to bootstrap from Cloudflare official sources.'
  }

  return 'Existing project import is disabled until real intake is implemented.'
}
