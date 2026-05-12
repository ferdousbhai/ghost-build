# GhostBuild Agent Notes

## Project

GhostBuild is a TanStack Start app on Cloudflare Workers. It lets a signed-in
user prompt a goal-driven Cloudflare-native coding agent that builds and deploys
web apps.

## Defaults

- Package manager: `pnpm`.
- Frontend: TanStack Start, TanStack Query, React.
- Runtime/deploy: Cloudflare Workers.
- Repository and Worker slug: `ghost-build`.
- Product strategy: be strictly better than generic Codex for Cloudflare web app
  builders by narrowing the scope to goal-driven web apps on the full
  Cloudflare stack.
- Auth: ChatGPT/Codex OAuth.
- Model: GPT-5.5.
- Reasoning effort: low by default.
- Model auth: ChatGPT/Codex OAuth for eligible Codex plan allowance.
- Codex OAuth routes: `/api/codex-auth/start`, `/api/codex-auth/callback`,
  `/api/codex-auth/status`, `/api/codex-auth/logout`.
- Codex OAuth env: `CODEX_OAUTH_CLIENT_ID`, `CODEX_OAUTH_CLIENT_SECRET`,
  `CODEX_OAUTH_AUTHORIZE_URL`, `CODEX_OAUTH_TOKEN_URL`,
  `CODEX_OAUTH_COOKIE_SECRET` or `BETTER_AUTH_SECRET`.
- Runtime request fields keep `model` and `reasoningEffort` separate. Do not add
  API-key fallback paths in the first iteration.
- MCP: only Cloudflare API MCP at `https://mcp.cloudflare.com/mcp`.
- Cloudflare API MCP OAuth is authorized per active builder session so the same
  Durable Object that runs Think turns owns the MCP tokens.
- Stripe Projects funded actions are user-owned. Each user connects their own
  Stripe Project, and GhostBuild stores only signed connection metadata and
  approval state.
- Stripe Projects env: `STRIPE_PROJECTS_CONNECT_URL` and
  `STRIPE_PROJECTS_COOKIE_SECRET` or the shared `CODEX_OAUTH_COOKIE_SECRET` /
  `BETTER_AUTH_SECRET`.
- Skills: project Cloudflare skill in `.codex/skills/cloudflare`.
- Goal model: every user turn may update the active goal. Keep objective,
  success criteria, status, and next concrete Cloudflare build step aligned.

## Guardrails

- Do not add product-specific MCP servers.
- Do not store raw payment card data.
- Use Cloudflare/Stripe agent payment flows for funded actions.
- Require explicit user confirmation before paid or destructive Cloudflare actions.
- Store only non-secret builder session state in browser storage.
- Keep UI prompt-first; do not expose generated code by default.
- Keep feature code modular under `src/features`.

## Checks

Run `pnpm test` and `pnpm build` before commit. Run `pnpm cf-typegen` after Cloudflare binding changes. Pushes to `main` deploy through `.github/workflows/deploy.yml` with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets.
