# Ghostbuild

Ghostbuild is an AI builder for projects that run on the Cloudflare developer platform. Full web applications default
to TanStack Start when the user does not request a framework; focused Workers, APIs, event handlers, and scripts use the
simplest Cloudflare-native execution surface that fits the request.

The root app runs as a TanStack Start app on Cloudflare Workers and uses TanStack Query and TanStack DB for client data. Generated projects start from a smaller `template/` snapshot with TanStack Start, TanStack Router, Cloudflare Workers, D1, R2, Workers AI, and Cloudflare Agents. The builder keeps TanStack for full browser applications and works directly in the Worker entrypoint for requests that do not benefit from a web framework; it adds feature-specific libraries and Cloudflare primitives only when needed.

## Getting Started

### Requirements

- Node.js 26+
- pnpm 11.14.0 (the version pinned by `packageManager` and CI)
- A Cloudflare account with Workers AI enabled
- Wrangler OAuth for local production deploys, or Cloudflare deploy credentials configured as CI secrets

### Production Deployment

Deploy production from CI or a server with Cloudflare deploy credentials available as secret-backed environment variables.
Set the non-secret OAuth client id in the deploy process environment; the deploy wrapper validates and passes it to
Wrangler explicitly. Do not store deploy credentials or runtime secrets in local env files.

```bash
pnpm install
export CLOUDFLARE_OAUTH_CLIENT_ID='<production OAuth client id>'
pnpm run deploy
```

The deploy command first runs the complete validation pipeline: stack alignment, generated TanStack routes and Cloudflare binding types, typechecking, builds, lint, tests, and dependency checks. It then provisions required production Cloudflare resources, verifies the resulting production config, applies D1 migrations to the production `ghostbuild` database, and publishes the production Worker with Wrangler.
Pushing to `main` also runs the production deploy workflow, which verifies the app and publishes directly to the production Cloudflare Worker through Cloudflare's official Wrangler GitHub Action.

Production is served from `https://ghostbuild.dev`; the temporary `workers.dev` endpoint is disabled. The Worker sends `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless` on app navigation responses so supported desktop browsers can start the WebContainer runtime.

The Ghostbuild Worker runtime uses the bindings declared in `wrangler.jsonc`:

- `DB` for D1 persistence
- `APP_STORAGE` for R2 snapshots, chat history, and share thumbnails
- `BuilderAgent` for the Cloudflare Agents Durable Object
- `DeploymentSandbox` for the build and publish Container-backed Durable Object
- `DeploymentWorkflow` for durable generated-app deployment orchestration
- `CF_VERSION_METADATA` for deployed Worker version metadata
- `CLIENT_TELEMETRY_RATE_LIMITER` for same-origin client telemetry abuse protection
- `CLOUDFLARE_OAUTH_START_RATE_LIMITER` for unauthenticated OAuth-start abuse protection

The production provisioning step creates or reuses the configured D1 database and R2 bucket, then writes the non-secret D1 database id into `wrangler.jsonc`. Configure secret values as Cloudflare Worker bindings, not local env files. Checked-in Wrangler configuration and explicit deploy arguments are the source of truth for non-secret variables: the root config declares the least-privilege OAuth scope list, while local and CI deploys inject the environment-specific `CLOUDFLARE_OAUTH_CLIENT_ID`. User Cloudflare credentials are encrypted with AES-GCM before persistence; configure a base64-encoded 32-byte `CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY` as a Worker secret before enabling account connections. Ghostbuild blocks generated-project writes to `.env`, `.env.*`, `.envrc`, `.dev.vars`, and `.dev.vars.*` files. The D1 database name is `ghostbuild`; production migrations use that stable database name instead of the `DB` binding name.

Worker observability is configured in `wrangler.jsonc` with persisted logs sampled at 60% and traces sampled at 5%, matching Cloudflare's current sampling guidance for production volume control.
Cloudflare Agents emit structured diagnostics-channel events for RPC, chat, recovery, state, schedule, workflow, and MCP operations. Attach a Tail Worker in production when those Agent events need to be collected separately from normal Worker logs and traces.
The 15-minute scheduled maintenance handler drains bounded object/Agent GC queues and bounded batches of expired OAuth states, expired app sessions, and old unreferenced encrypted credentials.

The production deploy preflight fails until provisioning has replaced the placeholder D1 id and
`CLOUDFLARE_OAUTH_CLIENT_ID` is present. Local production deploys can use Wrangler OAuth, while CI deploys should provide
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` as GitHub Actions secrets and the OAuth client id as a protected
production-environment variable.

### Generated App Deployment And Billing

Cloudflare OAuth is the only Ghostbuild authentication method. Users must authorize exactly one Cloudflare account
before chat, prompt enhancement, workspace startup, or deployment can begin. Ghostbuild's own deployment credentials
are never used to publish a user's generated project. For authenticated users,
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

Builder inference uses the OAuth-selected user's Cloudflare account through the Workers AI REST API. The root Worker has
no Workers AI binding and there is no Ghostbuild-funded inference fallback. Use Wrangler OAuth for local production
deploys, or configure `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` as GitHub Actions deploy secrets for CI
authentication. The app does not support Google login, Better Auth, or non-Workers-AI provider keys.

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
- `app/agents/` and `app/lib/.server/` own the durable agent loop, model orchestration, recovery, and Workers AI adapter.
- `ghostbuild-agent/` contains the shared protocol types, prompts, parsing, workspace-context selection, and tool definitions used by the browser and root Worker.
- `template/` contains the TanStack Start + Cloudflare template used for generated apps.
- `migrations/` contains D1 schema migrations.

## Contributing and Security

Contributions are welcome. Read [CONTRIBUTING.md](./CONTRIBUTING.md), follow the
[Code of Conduct](./CODE_OF_CONDUCT.md), and run `pnpm run validate` before submitting a pull request. Report suspected
vulnerabilities privately according to [SECURITY.md](./SECURITY.md).

Ghostbuild is licensed under the [Apache License 2.0](./LICENSE).
