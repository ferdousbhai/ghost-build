# GhostBuild

GhostBuild has been consolidated into SummonGhost Code. The production feature
now lives in the SummonGhost repository at `summonghost.com/code` and
`code.summonghost.com`, reusing SummonGhost auth, sessions, user accounts, model
runtime, Cloudflare MCP authorization, and approval boundaries.

This repository is retired. It no longer has custom-domain routes or an
automatic production deploy workflow.

GhostBuild is an open-source, goal-driven coding agent for developers who want
to build web apps on the full Cloudflare stack and deploy them as Cloudflare
Workers.

## Business Logic

- Users sign in with Better Auth through Google or GitHub.
- The product shell is TanStack Start with TanStack Query for workflow state and
  async client/server actions.
- The default model is GPT-5.5 with low reasoning for planning and coding work.
- Agent runs use GhostBuild's server-side OpenAI API key.
- Every user turn can update the active goal. The agent keeps an objective,
  success criteria, status, and next Cloudflare build step.
- Better Auth handles app sessions under `/api/auth/*`. Session data is stored
  in the bound D1 database and protected by `BETTER_AUTH_SECRET`; it is never
  written to localStorage.
- Configure `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, and `GITHUB_CLIENT_SECRET` to
  enable Google/GitHub sign-in.
- Model selection and reasoning effort are separate request fields. Model calls
  use the server-side `OPENAI_API_KEY`.
- Builder session metadata, selected source, model policy, run status, and last
  plan are persisted as non-secret browser state so users can return to the
  previous builder session.
- The Ghost has Cloudflare Skills and the Cloudflare API MCP server available by default.
- Cloudflare API MCP authorization is session-scoped. After a builder session
  exists, the UI can open Cloudflare OAuth and the Agents SDK stores MCP tokens
  in the session agent's Durable Object storage.
- GhostBuild is intentionally narrower than Codex: web apps only, Cloudflare
  stack first, preview/deploy workflow built in.
- The app avoids product-specific MCP servers; Cloudflare platform actions route through the Cloudflare API MCP server.
- Generated apps deploy to Cloudflare Workers.
- Paid infrastructure is handled through Cloudflare/Stripe agent flows, including account setup, domains, and Cloudflare usage.
- Each user connects their own Stripe Project before paid Cloudflare actions.
  GhostBuild stores only signed connection metadata and approval state; raw
  payment card data and payment tokens stay out of the app.
- GhostBuild never stores raw payment card data.
- Paid or destructive Cloudflare actions require auditable confirmation records
  before the matching action preset can execute.

The core product flow is prompt -> plan -> agent actions -> preview -> deploy.

## Deployment

This repository no longer deploys to production. The remaining GitHub Actions
workflow is manual-only and runs tests/builds as an archival check.

Historical deploys used Cloudflare's official Wrangler action with these
repository secrets:

- `CLOUDFLARE_API_TOKEN`: Cloudflare API token with Workers deploy access.
- `CLOUDFLARE_ACCOUNT_ID`: Cloudflare account ID for the target account.

Runtime secrets such as `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`,
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`,
`GITHUB_CLIENT_SECRET`, and `OPENAI_API_KEY` still need to be configured in
Cloudflare for the deployed Worker.

Stripe Projects funded actions need:

- `STRIPE_PROJECTS_HOSTED_CONNECT_URL`: hosted Stripe Projects onboarding URL
  for starting the per-user connection flow. This is a shared entrypoint, not a
  shared Stripe Project.
- `STRIPE_PROJECTS_COOKIE_SECRET`: signing secret for Stripe Projects cookies.
  If omitted, `BETTER_AUTH_SECRET` is reused.
