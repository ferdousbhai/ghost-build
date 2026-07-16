# Ghostbuild

Ghostbuild is an AI builder for projects that run on the Cloudflare developer platform. Full web applications default
to TanStack Start when the user does not request a framework; focused Workers, APIs, event handlers, and scripts use the
simplest Cloudflare-native execution surface that fits the request.

The root app runs as a TanStack Start app on Cloudflare Workers and uses TanStack Query and TanStack DB for client data. Generated projects start from a smaller `template/` snapshot with TanStack Start, TanStack Router, Cloudflare Workers, D1, R2, Workers AI, and Cloudflare Agents. The builder keeps TanStack for full browser applications and works directly in the Worker entrypoint for requests that do not benefit from a web framework; it adds feature-specific libraries and Cloudflare primitives only when needed.

## Getting Started

### Requirements

- Node.js 26+
- pnpm 9.5.0 (the version pinned by `packageManager` and CI)
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

The production provisioning step creates or reuses the configured D1 database and R2 bucket, then writes the non-secret D1 database id into `wrangler.jsonc`. Configure secret and variable values in Cloudflare Worker bindings, not local env files. User Cloudflare credentials are encrypted with AES-GCM before persistence; configure a base64-encoded 32-byte `CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY` as a Worker secret before enabling account connections. Ghostbuild blocks generated-project writes to `.env`, `.env.*`, `.envrc`, `.dev.vars`, and `.dev.vars.*` files. The D1 database name is `ghostbuild`; production migrations use that stable database name instead of the `DB` binding name.

Worker observability is configured in `wrangler.jsonc` with persisted logs sampled at 60% and traces sampled at 5%, matching Cloudflare's current sampling guidance for production volume control.
Cloudflare Agents emit structured diagnostics-channel events for RPC, chat, recovery, state, schedule, workflow, and MCP operations. Attach a Tail Worker in production when those Agent events need to be collected separately from normal Worker logs and traces.

The production deploy preflight fails until provisioning has replaced the placeholder D1 id. Local production deploys can use Wrangler OAuth, while CI deploys should provide `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` as GitHub Actions secrets.

### Generated App Deployment And Billing

Ghostbuild's own deployment credentials are never used to publish a user's generated project. For signed-in users,
the browser uploads an immutable secret-excluding ZIP source snapshot and asks the root Worker to prepare
an exact Cloudflare resource plan. The plan always identifies the user's connected Cloudflare account as the billing
source for the Worker, D1, R2, Durable Object, and Workers AI. The user must approve the plan digest in the chat before
server-side provisioning can begin. A changed snapshot, plan, owner, or Cloudflare connection invalidates that approval.
Validation, build, and publish commands run in pinned, egress-restricted Cloudflare Sandboxes. The decrypted user credential remains
in Ghostbuild's Worker and is never placed in generated code, the browser, or a sandbox.

Workers Paid is a separate consent boundary. Exhausting a free Workers AI allocation must prompt for authorization and
must never cause an automatic plan upgrade. Existing Cloudflare users connect through Cloudflare's public OAuth
Authorization Code + PKCE flow; access and refresh tokens are encrypted and remain server-side. The adapter fails closed
when Ghostbuild's OAuth client is not configured. The unpublished Cloudflare/Stripe Orchestrator remains an optional
future onboarding path for users without an existing account; Ghostbuild does not use Tenant API resale or collect broad
user-supplied API tokens.

### Workers AI

Only Workers AI models are supported. The coding-agent model is:

```txt
@cf/zai-org/glm-5.2
```

The app uses the Cloudflare `AI` binding at runtime and does not need model-provider API keys. Use Wrangler OAuth for local production deploys, or configure `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` as GitHub Actions deploy secrets for CI authentication. Better Auth/Google secrets and optional commit metadata should be configured as Cloudflare bindings. The app does not support non-Workers-AI provider keys.

The app tracks the latest AI SDK v6 peer line because the current Cloudflare Agents SDK, `@cloudflare/ai-chat`, and `workers-ai-provider` releases declare AI SDK v6 as their supported integration surface.

### Template

Generated apps come from the snapshot in `public/template-snapshot-*.bin`. Rebuild it after changing `template/`:

```bash
pnpm run rebuild-template
```

## Useful Commands

```bash
pnpm run validate
pnpm run deploy
```

## Repository Layout

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) documents module boundaries, dependency direction, and the agent context flow.
- `app/` contains the TanStack Start app, Worker entry, routes, components, and Cloudflare data handlers.
- `app/agents/` contains Cloudflare Agents integration.
- `app/lib/cloudflare/` contains the local data client and Worker persistence bridge.
- `ghostbuild-agent/` contains the agent loop, prompts, tools, and Workers AI model integration.
- `template/` contains the TanStack Start + Cloudflare template used for generated apps.
- `migrations/` contains D1 schema migrations.
