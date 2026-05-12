import type { AgentGoal, AgentPlanRequest, ProjectSource } from './agent'
import type { ModelName, ReasoningEffort } from './model-catalog'

export type BuilderRunStatus = 'idle' | 'running' | 'completed' | 'failed'

export type BuilderSession = {
  sessionId: string
  projectId: string
  deploymentSlug: string
  selectedSource: ProjectSource
  modelPolicy: {
    model: ModelName
    reasoningEffort: ReasoningEffort
  }
  goal: AgentGoal
  runStatus: BuilderRunStatus
  createdAt: string
  updatedAt: string
}

export function createBuilderSession(
  input: Pick<AgentPlanRequest, 'projectSource' | 'model' | 'reasoningEffort'> & {
    idea: string
    goal: AgentGoal
    now?: Date
  },
): BuilderSession {
  const now = input.now ?? new Date()
  const sessionId = createId('session')
  const projectId = createId(input.projectSource.type === 'new' ? 'project' : 'import')

  return {
    sessionId,
    projectId,
    deploymentSlug: slugifyDeploymentName(input.idea),
    selectedSource: input.projectSource,
    modelPolicy: {
      model: input.model,
      reasoningEffort: input.reasoningEffort,
    },
    goal: input.goal,
    runStatus: 'idle',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }
}

export function slugifyDeploymentName(idea: string) {
  return (
    idea
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 42) || 'ghostbuild-app'
  )
}

function createId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`
}
