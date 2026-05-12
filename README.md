# GhostBuild

GhostBuild is an open-source, goal-driven coding agent for developers who want
to build web apps on the full Cloudflare stack and deploy them as Cloudflare
Workers.

## Business Logic

- Users sign in with ChatGPT/Codex OAuth.
- The default model is GPT-5.5 with low reasoning for planning and coding work.
- Eligible runs use the user's existing Codex plan allowance.
- Every user turn can update the active goal. The agent keeps an objective,
  success criteria, status, and next Cloudflare build step.
- ChatGPT/Codex OAuth uses PKCE routes under `/api/codex-auth/*`. OAuth token
  material is stored in encrypted HttpOnly cookies using
  `CODEX_OAUTH_COOKIE_SECRET` or `BETTER_AUTH_SECRET`; it is never written to
  localStorage.
- Configure `CODEX_OAUTH_CLIENT_ID`, `CODEX_OAUTH_CLIENT_SECRET`,
  `CODEX_OAUTH_AUTHORIZE_URL`, and `CODEX_OAUTH_TOKEN_URL` to enable the Codex
  OAuth flow. Without those variables the UI shows a recovery path, but the
  start route returns a configuration error.
- Model selection and reasoning effort are separate request fields. Model auth
  is always ChatGPT/Codex OAuth in this iteration.
- Builder session metadata, selected source, model policy, run status, and last
  plan are persisted as non-secret browser state so users can return to the
  previous builder session.
- The Ghost has Cloudflare Skills and the Cloudflare API MCP server available by default.
- GhostBuild is intentionally narrower than Codex: web apps only, Cloudflare
  stack first, preview/deploy workflow built in.
- The app avoids product-specific MCP servers; Cloudflare platform actions route through the Cloudflare API MCP server.
- Generated apps deploy to Cloudflare Workers.
- Paid infrastructure is handled through Cloudflare/Stripe agent flows, including account setup, domains, and Cloudflare usage.
- GhostBuild never stores raw payment card data.
- Paid or destructive Cloudflare actions require auditable confirmation records
  before the matching action preset can execute.

The core product flow is prompt -> plan -> agent actions -> preview -> deploy.

## Deployment

Pushes to `main` deploy the `ghost-build` Worker through GitHub Actions using
Cloudflare's official Wrangler action. Configure these repository secrets before
the first automated deploy:

- `CLOUDFLARE_API_TOKEN`: Cloudflare API token with Workers deploy access.
- `CLOUDFLARE_ACCOUNT_ID`: Cloudflare account ID for the target account.

Runtime OAuth secrets such as `CODEX_OAUTH_CLIENT_ID`,
`CODEX_OAUTH_CLIENT_SECRET`, `CODEX_OAUTH_AUTHORIZE_URL`,
`CODEX_OAUTH_TOKEN_URL`, and `CODEX_OAUTH_COOKIE_SECRET` still need to be
configured in Cloudflare for the deployed Worker.
