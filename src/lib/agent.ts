export type AgentPlanRequest = {
  idea: string
  audience: string
  deploymentTarget: string
}

export type AgentPlan = {
  summary: string
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
    workerName: string
    route: string
    domain: string
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

const defaultIdea =
  'A booking and intake app for an independent home-services business.'

export function normalizePlanRequest(input: Partial<AgentPlanRequest>) {
  return {
    idea: input.idea?.trim() || defaultIdea,
    audience: input.audience?.trim() || 'non-technical founder',
    deploymentTarget: input.deploymentTarget?.trim() || 'Cloudflare Worker',
  }
}

export function buildAgentPlan(input: Partial<AgentPlanRequest>): AgentPlan {
  const request = normalizePlanRequest(input)
  const slug = request.idea
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 42)

  return {
    summary: `Ghost Coder will turn "${request.idea}" into a deployable product for a ${request.audience}, then ship it to ${request.deploymentTarget}.`,
    phases: [
      {
        title: 'Clarify the product',
        detail:
          'Extract jobs-to-be-done, required pages, data model, user roles, and launch constraints from the idea.',
        status: 'ready',
      },
      {
        title: 'Generate the worker app',
        detail:
          'Create a Cloudflare-native full-stack app with server routes, Think workspace files, Durable Object state, D1 data, R2 assets, and Workers AI hooks.',
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
      workerName: slug || 'ghost-coder-app',
      route: `workers/${slug || 'ghost-coder-app'}`,
      domain: `${slug || 'ghost-coder-app'}.pages.dev`,
      readiness: 42,
    },
    defaults: {
      runtime: '@cloudflare/think on the Cloudflare Agents SDK',
      modelProvider: 'OpenAI via Cloudflare AI Gateway when configured',
      model: 'gpt-5.5',
      reasoning: 'low',
      credentialStorage: [
        'OpenAI API key is provided by the user',
        'OpenAI API key is stored only in the user browser',
        'Ghost Coder does not proxy or custody model billing by default',
        'Cloudflare authorization uses scoped OAuth or API tokens',
      ],
      paymentFlow: [
        'Cloudflare and Stripe handle payment collection for paid infrastructure',
        'Ghost Coder never stores raw card data',
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
