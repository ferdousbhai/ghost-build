import { createBuilderSession } from './builder-session'
import {
  defaultModel,
  normalizeReasoningEffort,
  type ModelName,
  type ReasoningEffort,
} from './model-catalog'

export type AgentPlanRequest = {
  idea: string
  audience: string
  deploymentTarget: string
  projectSource: ProjectSource
  model: ModelName
  reasoningEffort: ReasoningEffort
  goal?: AgentGoalInput
}

export type { ModelName, ReasoningEffort }

export type AgentGoalInput = {
  objective?: string
  successCriteria?: Array<string>
  evidence?: AgentGoalEvidence
}

export type AgentGoalEvidence = {
  generated?: boolean
  previewReady?: boolean
  checksPassed?: boolean
  deployed?: boolean
  deploymentUrl?: string
  completedCriteria?: Array<string>
  blockers?: Array<string>
}

export type ProjectSource =
  | {
      type: 'new'
      starter: string
      command: string
      sourceUrl: string
    }
  | {
      type: 'github'
      repository: string
    }
  | {
      type: 'upload'
      uploadKind: 'zip' | 'folder' | 'files'
      fileCount: number
    }

export type AgentPlan = {
  summary: string
  goal: AgentGoal
  phases: Array<{
    title: string
    detail: string
    status: 'ready' | 'queued' | 'blocked'
  }>
  stack: Array<{
    name: string
    role: string
    state: 'connected' | 'planned' | 'required'
  }>
  deployment: {
    sessionId: string
    projectId: string
    workerName: string
    route: string
    domain: string
    bindings: Array<string>
    readiness: number
  }
  defaults: {
    runtime: string
    modelProvider: string
    model: string
    reasoning: string
    credentialStorage: Array<string>
    paymentFlow: Array<string>
    provisioning: Array<string>
    mcpServers: Array<{
      name: string
      url: string
    }>
    skills: Array<string>
  }
}

export type AgentGoal = {
  objective: string
  status: 'active' | 'completed' | 'blocked'
  successCriteria: Array<string>
}

const defaultIdea =
  'A booking and intake app for an independent home-services business.'

export function normalizePlanRequest(input: Partial<AgentPlanRequest>) {
  const model = input.model ?? defaultModel.id

  return {
    idea: input.idea?.trim() || defaultIdea,
    audience: input.audience?.trim() || 'non-technical founder',
    deploymentTarget: input.deploymentTarget?.trim() || 'Cloudflare Worker',
    projectSource: input.projectSource ?? {
      type: 'new',
      starter: 'TanStack Start on Cloudflare Workers',
      command:
        'pnpm create cloudflare@latest my-tanstack-start-app --framework=tanstack-start',
      sourceUrl:
        'https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack-start/',
    },
    model,
    reasoningEffort: normalizeReasoningEffort(model, input.reasoningEffort),
    goal: input.goal,
  }
}

export function buildAgentPlan(input: Partial<AgentPlanRequest>): AgentPlan {
  const request = normalizePlanRequest(input)
  const goal = buildAgentGoal(request)
  const session = createBuilderSession({ ...request, goal })

  return {
    summary: `GhostBuild will turn "${request.idea}" into a deployable product for a ${request.audience}, then ship it to ${request.deploymentTarget}.`,
    goal,
    phases: [
      {
        title: 'Prepare the project source',
        detail: describeProjectSource(request.projectSource),
        status: 'ready',
      },
      {
        title: 'Connect model auth',
        detail: describeModelAuth(),
        status: 'blocked',
      },
      {
        title: 'Set model policy',
        detail: `Use ${request.model} with ${request.reasoningEffort} reasoning effort for agent turns.`,
        status: 'ready',
      },
      {
        title: 'Clarify the product',
        detail:
          'Extract jobs-to-be-done, required pages, data model, user roles, and launch constraints from the idea.',
        status: 'ready',
      },
      {
        title: 'Generate the worker app',
        detail: buildGenerationDetail(request.projectSource),
        status: 'queued',
      },
      {
        title: 'Review and repair',
        detail:
          'Run static checks, preview the UI, inspect route behavior, and ask the agent to patch failed checks before deploy.',
        status: 'queued',
      },
      {
        title: 'Deploy to production',
        detail:
          'Provision or link the Cloudflare account, issue a scoped API token, purchase an approved domain, bind resources, and publish the production URL.',
        status: 'blocked',
      },
    ],
    stack: [
      {
        name: 'TanStack Start',
        role: 'Routes, SSR, server handlers, and deployable app shell',
        state: 'connected',
      },
      {
        name: 'TanStack Query',
        role: 'Agent plan, build status, deploy logs, and background polling',
        state: 'connected',
      },
      {
        name: 'Cloudflare Agents SDK',
        role: 'Durable Object agent runtime, state, routing, sockets, and MCP client support',
        state: 'connected',
      },
      {
        name: 'Cloudflare Think',
        role: 'Opinionated coding-agent base with workspace tools, persisted sessions, compaction, search, MCP merge, and recovery',
        state: 'connected',
      },
      {
        name: 'Cloudflare API MCP server',
        role: 'Default account, Worker, DNS, domain, D1, R2, AI, and observability access through Cloudflare managed MCP',
        state: 'connected',
      },
      {
        name: 'Cloudflare Skills',
        role: 'Default contextual skills and commands for building, deploying, and debugging on Cloudflare',
        state: 'connected',
      },
      {
        name: 'Workers AI + AI Gateway',
        role: 'LLM calls, routing, caching, eval traces, and provider controls',
        state: 'required',
      },
    ],
    deployment: {
      sessionId: session.sessionId,
      projectId: session.projectId,
      workerName: session.deploymentSlug,
      route: `workers/${session.deploymentSlug}`,
      domain: `${session.deploymentSlug}.pages.dev`,
      bindings: ['Cloudflare API MCP', 'Cloudflare account token'],
      readiness: 42,
    },
    defaults: {
      runtime: '@cloudflare/think on the Cloudflare Agents SDK',
      modelProvider: 'ChatGPT/Codex sign-in using eligible Codex plan allowance',
      model: request.model,
      reasoning: request.reasoningEffort,
      credentialStorage: [
        'ChatGPT/Codex token material is encrypted in HttpOnly cookies',
        'GhostBuild uses ChatGPT/Codex OAuth for model access',
        'Cloudflare authorization uses scoped OAuth or API tokens',
      ],
      paymentFlow: [
        'Cloudflare and Stripe handle payment collection for paid infrastructure',
        'GhostBuild never stores raw card data',
        'The agent requests approval before paid Cloudflare actions',
        'Cloudflare-owned payment tokens or hosted checkout complete purchases',
      ],
      provisioning: [
        'Discover Cloudflare services available to the agent',
        'Create or link a Cloudflare account after user authorization',
        'Hand off payment collection to Cloudflare and Stripe hosted flows',
        'Issue scoped credentials for the agent to deploy immediately',
        'Register a domain after explicit user approval',
      ],
      mcpServers: [
        {
          name: 'Cloudflare API',
          url: 'https://mcp.cloudflare.com/mcp',
        },
      ],
      skills: [
        'workers',
        'durable-objects',
        'd1',
        'r2',
        'workers-ai',
        'agents-sdk',
        'ai-gateway',
        'wrangler',
      ],
    },
  }
}

function buildAgentGoal(request: ReturnType<typeof normalizePlanRequest>): AgentGoal {
  const successCriteria =
    request.goal?.successCriteria?.filter(Boolean) ??
    defaultSuccessCriteria(request)

  return {
    objective:
      request.goal?.objective?.trim() ||
      `Build and deploy ${request.idea} as a Cloudflare-native web app.`,
    status: evaluateGoalStatus(successCriteria, request.goal?.evidence),
    successCriteria,
  }
}

export function evaluateGoalStatus(
  successCriteria: Array<string>,
  evidence?: AgentGoalEvidence,
): AgentGoal['status'] {
  if (evidence?.blockers?.length) {
    return 'blocked'
  }

  const completedCriteria = new Set(evidence?.completedCriteria ?? [])
  const allCriteriaMet =
    successCriteria.length > 0 &&
    successCriteria.every((criterion) => completedCriteria.has(criterion))

  if (
    allCriteriaMet ||
    (evidence?.generated &&
      evidence.previewReady &&
      evidence.checksPassed &&
      evidence.deployed)
  ) {
    return 'completed'
  }

  return 'active'
}

function defaultSuccessCriteria(request: ReturnType<typeof normalizePlanRequest>) {
  return [
    `The app serves the core ${request.audience} workflow described in the prompt.`,
    'The implementation runs as a Cloudflare Worker using the GhostBuild Cloudflare stack.',
    'Cloudflare resources, paid actions, and destructive actions are gated by explicit approval.',
    'The final run produces a preview or deployment path with checks completed.',
  ]
}

function describeModelAuth() {
  return 'Sign in with ChatGPT/Codex so eligible users can use their existing Codex plan allowance.'
}

function describeProjectSource(source: ProjectSource) {
  if (source.type === 'new') {
    return `Start from the official Cloudflare TanStack Start template using "${source.command}", then add TanStack Query workflows and GhostBuild defaults.`
  }

  if (source.type === 'github') {
    return source.repository
      ? `Clone ${source.repository}, inspect its framework, dependencies, build scripts, and Cloudflare readiness before making changes.`
      : 'Connect GitHub, let the user choose a repository, then inspect framework, dependencies, build scripts, and Cloudflare readiness before making changes.'
  }

  const uploadLabel =
    source.uploadKind === 'zip'
      ? 'uploaded zip'
      : source.uploadKind === 'folder'
        ? 'uploaded folder'
        : 'uploaded files'

  return `Import the ${uploadLabel}, preserve the existing structure, scan ${source.fileCount || 'all'} file(s), and plan changes against the current codebase.`
}

function buildGenerationDetail(source: ProjectSource) {
  if (source.type === 'new') {
    return 'Create a Cloudflare-native TanStack Start app with TanStack Query, server routes, Think workspace files, Durable Object state, D1 data, R2 assets, and Workers AI hooks.'
  }

  return 'Patch the existing project in place, adding the minimum required routes, data, storage, auth, Cloudflare bindings, tests, and deploy configuration without hiding the user codebase.'
}
