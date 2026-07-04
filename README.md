# Ghostbuild

Ghostbuild is an AI app builder for generating TanStack Start applications that run on the Cloudflare developer platform.

The root app runs as a TanStack Start app on Cloudflare Workers. Generated apps are built from the `template/` snapshot and use the same stack: TanStack Start, TanStack Router, TanStack Query, TanStack DB, Cloudflare Workers, D1, R2, Workers AI, and Cloudflare Agents.

## Getting Started

### Requirements

- Node.js 26+
- pnpm 9+
- A Cloudflare account with Workers AI enabled
- Wrangler OAuth for local production deploys, or Cloudflare deploy credentials configured as CI secrets

### Production Deployment

Deploy production from CI or a server with Cloudflare deploy credentials available as secret-backed environment variables. Do not store deploy credentials or runtime secrets in local env files.

```bash
pnpm install
pnpm run deploy
```

The deploy command verifies stack alignment, regenerates TanStack routes and Cloudflare binding types, typechecks the Worker, provisions required production Cloudflare resources, verifies the production Cloudflare config, builds the TanStack Start app, runs lint/tests/dependency checks, applies D1 migrations to the production `ghostbuild` database, and publishes the production Worker with Wrangler.
Pushing to `main` also runs the production deploy workflow, which verifies the app and publishes directly to the production Cloudflare Worker through Cloudflare's official Wrangler GitHub Action.

The Worker runtime uses the bindings declared in `wrangler.jsonc`:

- `AI` for Workers AI
- `DB` for D1 persistence
- `APP_STORAGE` for R2 snapshots, chat history, and share thumbnails
- `BuilderAgent` for Cloudflare Agents

The production provisioning step creates or reuses the configured D1 database and R2 bucket, then writes the non-secret D1 database id into `wrangler.jsonc`. Configure secret and variable values in Cloudflare Worker bindings, not local env files. Ghostbuild blocks generated-project writes to `.env`, `.env.*`, `.envrc`, `.dev.vars`, and `.dev.vars.*` files. The D1 database name is `ghostbuild`; production migrations use that stable database name instead of the `DB` binding name.

Worker observability is configured in `wrangler.jsonc` with persisted logs sampled at 60% and traces sampled at 5%, matching Cloudflare's current sampling guidance for production volume control.
Cloudflare Agents emit structured diagnostics-channel events for RPC, chat, recovery, state, schedule, workflow, and MCP operations. Attach a Tail Worker in production when those Agent events need to be collected separately from normal Worker logs and traces.

The production deploy preflight fails until provisioning has replaced the placeholder D1 id. Local production deploys can use Wrangler OAuth, while CI deploys should provide `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` as GitHub Actions secrets.

### Workers AI

Only Workers AI models are supported. The coding-agent model is:

```txt
@cf/zai-org/glm-5.2
```

The app uses the Cloudflare `AI` binding at runtime and does not need model-provider API keys. Use Wrangler OAuth for local production deploys, or configure `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` as GitHub Actions deploy secrets for CI authentication. Optional runtime values such as Axiom, Better Auth/Google auth secrets, public PostHog/Sentry config, site URL, and commit SHA metadata should be configured as Cloudflare bindings. The app does not support non-Workers-AI provider keys.

The app tracks the latest AI SDK v6 peer line because the current Cloudflare Agents SDK, `@cloudflare/ai-chat`, and `workers-ai-provider` releases declare AI SDK v6 as their supported integration surface.

### Template

Generated apps come from the snapshot in `public/template-snapshot-*.bin`. Rebuild it after changing `template/`:

```bash
pnpm run rebuild-template
```

## Useful Commands

```bash
pnpm run generate-routes
pnpm run cf-typegen
pnpm run verify:stack
pnpm run verify:template
pnpm run typecheck
pnpm run build
pnpm run test
pnpm run deploy
```

## Repository Layout

- `app/` contains the TanStack Start app, Worker entry, routes, components, and Cloudflare data handlers.
- `app/agents/` contains Cloudflare Agents integration.
- `app/lib/cloudflare/` contains the local data client and Worker persistence bridge.
- `ghostbuild-agent/` contains the agent loop, prompts, tools, and Workers AI model integration.
- `template/` contains the TanStack Start + Cloudflare template used for generated apps.
- `migrations/` contains D1 schema migrations.
