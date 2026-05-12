import type { AgentPlanRequest } from '#/lib/agent'

export const initialAgentRequest: AgentPlanRequest = {
  idea: '',
  audience: 'non-technical founder',
  deploymentTarget: 'Cloudflare Worker with a custom domain',
  projectSource: {
    type: 'new',
    starter: 'TanStack Start on Cloudflare Workers',
    command:
      'pnpm create cloudflare@latest my-tanstack-start-app --framework=tanstack-start',
    sourceUrl:
      'https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack-start/',
  },
  model: 'gpt-5.5',
  reasoningEffort: 'low',
  goal: {
    objective: '',
    successCriteria: [],
  },
}

export const promptSuggestions = [
  'Build a booking app for a mobile detailing business with deposits, reminders, and an admin calendar.',
  'Create a paid community site with member profiles, posts, events, and Stripe subscriptions.',
  'Make a client portal for a law firm with intake forms, secure uploads, and case status updates.',
]

export const buildEvents = [
  'Understanding the product and user roles',
  'Planning routes, data, storage, auth, and deploy bindings',
  'Generating the TanStack Start application',
  'Preparing the Cloudflare Worker deployment path',
]

export const defaultCapabilities = [
  'Cloudflare API MCP server only',
  'Cloudflare Skills loaded by default',
  'Think workspace, memory, and tool loop',
  'GPT-5.5 with low reasoning',
  'GhostBuild account with server-side OpenAI API billing',
  'Cloudflare Workers, D1, R2, KV, Queues, AI Gateway',
  'Goal-driven planning for Cloudflare web apps',
]

export const cloudflareStackReadiness = [
  'Workers',
  'D1',
  'R2',
  'KV',
  'Queues',
  'AI Gateway',
  'MCP',
]

export const productionSteps = [
  'Confirm the active goal and success criteria',
  'Plan the Cloudflare architecture',
  'Generate the TanStack Start Worker app',
  'Run checks and preview the Worker',
  'Request approval for paid or destructive actions',
  'Deploy to Cloudflare when approvals are complete',
]

export const ownershipLineItems = [
  ['Model access', 'Handled through GhostBuild server-side OpenAI billing'],
  ['Cloudflare billing', 'Handled by Cloudflare and Stripe hosted payment flows'],
  ['Paid actions', 'Domains and account purchases require explicit approval'],
] as const
