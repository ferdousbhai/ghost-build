import type { AgentPlanRequest } from '#/lib/agent'

export const initialAgentRequest: AgentPlanRequest = {
  idea: '',
  audience: 'non-technical founder',
  deploymentTarget: 'Cloudflare Worker with a custom domain',
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
  'User-provided OpenAI key',
  'Create or link Cloudflare accounts',
  'Cloudflare/Stripe handles paid infrastructure',
]

export const productionSteps = [
  'Discover Cloudflare services',
  'Authorize or create account',
  'Collect payment through Cloudflare/Stripe',
  'Issue scoped API token',
  'Register approved domain',
  'Deploy Worker to production',
]

export const ownershipLineItems = [
  ['OpenAI key', 'Stored in this browser and used for GPT-5.5 model calls'],
  ['Cloudflare billing', 'Handled by Cloudflare and Stripe hosted payment flows'],
  ['Paid actions', 'Domains and account purchases require explicit approval'],
] as const
