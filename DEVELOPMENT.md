# Development

Ghostbuild is developed as a TanStack Start app deployed to Cloudflare Workers.

## One-Time Setup

```bash
nvm install
nvm use
npm install -g pnpm@9.5.0
pnpm install
```

Provision the Cloudflare resources used by production deployments:

```bash
pnpm run provision:production
```

The provision step creates or reuses the configured D1 database and R2 bucket, then writes the non-secret D1 `database_id` into `wrangler.jsonc`.

## Production Runtime Configuration

Configure all runtime secrets and variables as Cloudflare Worker bindings. Do not store secret values in local env files. Generated-project writes to `.env`, `.env.*`, `.envrc`, `.dev.vars`, and `.dev.vars.*` files are blocked.

Workers AI uses the `AI` binding directly. Use Wrangler OAuth for local production deploys. `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` are CI deploy credentials only; configure them as GitHub Actions secrets for Wrangler authentication, not as Worker runtime secrets.

Optional bindings include `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and commit SHA metadata.

The app tracks the latest AI SDK v6 peer line because the current Cloudflare Agents SDK and `workers-ai-provider` releases declare v6 as their supported AI SDK integration surface.

Worker observability is explicit in `wrangler.jsonc`: persisted logs are sampled at 60% and traces at 5% unless production volume requires a deliberate change.
Agent-specific diagnostics are emitted through Cloudflare Agents diagnostics-channel events. Attach a Tail Worker in production when structured Agent RPC, chat, recovery, state, schedule, workflow, or MCP events need to be collected.

Build tooling targets Node.js 26+.

## Verification

Run the same validation pipeline used by CI before opening a pull request:

```bash
pnpm run validate
```

## Deployment

Production deploys run from the `Production Deploy` GitHub Actions workflow on pushes to `main` and manual `workflow_dispatch` runs. Configure `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` as GitHub Actions secrets for deploy authentication, and keep runtime values configured as Cloudflare Worker bindings. The final publish step uses Cloudflare's official Wrangler GitHub Action.

```bash
pnpm run deploy
```

The deploy command runs the complete validation pipeline, provisions required Cloudflare resources, verifies production Cloudflare config, applies production D1 migrations with `wrangler d1 migrations apply ghostbuild --remote`, and publishes the Worker with Wrangler. Provisioning uses the active Wrangler auth session locally and CI-provided Cloudflare secrets in GitHub Actions.

## Template Work

Generated apps are created from `template/`. After changing the template, rebuild the bootstrap snapshot:

```bash
pnpm run rebuild-template
```
