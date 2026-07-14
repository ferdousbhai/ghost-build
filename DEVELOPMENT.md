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

User-account connection uses Cloudflare's public OAuth Authorization Code flow with PKCE. Create a server-side OAuth
client in **Manage Account → OAuth clients**, register
`https://<ghostbuild-origin>/api/cloudflare/connection/callback`, verify the client domain, and make the client public.
Configure response type **Code**, grant type **Authorization Code**, and token authentication method **Client Secret
Basic**. Select only the account permissions needed by the generated stack: Account Settings Read, Workers Scripts
Write, D1 Write, Workers R2 Storage Write, and Workers AI Read. Cloudflare's live OAuth scope catalog currently assigns
these IDs: `account-settings.read`, `workers-scripts.write`, `d1.write`, `workers-r2.write`, and `ai.read`. Configure those
identifiers plus `offline_access` as a space-delimited binding. Ghostbuild fails closed without offline access because a
short-lived access token that cannot be refreshed would eventually break deployments and connected-account inference.

Cloudflare creates OAuth clients as private. Before promoting the client, add a logo and a `ghostbuild.dev` client URL,
then complete Cloudflare's DNS TXT ownership verification for that domain. Promotion to public is permanent, so confirm
the production callback, client URL, metadata, and least-privilege scopes before changing visibility:

- `CLOUDFLARE_OAUTH_CLIENT_ID`
- `CLOUDFLARE_OAUTH_SCOPES`
- `CLOUDFLARE_OAUTH_CLIENT_SECRET` (Worker secret)

Access and refresh tokens are encrypted before D1 persistence. Expired access tokens are refreshed server-side and
rotated in the encrypted credential record.

Cloudflare account connections also require `CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY`. Generate and configure the
32-byte key as a production Worker secret; never write it into the repository or a local env file:

```bash
openssl rand -base64 32 | wrangler secret put CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY
```

The deployment egress proxy uses an independent HMAC secret. Its short-lived token identifies an approved plan; it is
not a Cloudflare credential and cannot expand the plan's permissions:

```bash
openssl rand -base64 32 | wrangler secret put DEPLOYMENT_PROXY_JWT_SECRET
```

The deployment sandbox image is pinned in `Dockerfile.sandbox`. Building or dry-running a container update requires a
running Docker-compatible daemon. The sandbox denies internet access by default and never receives the decrypted user
Cloudflare credential.

Approved deployments are started through the `ghostbuild-deployments` Workflow binding. The HTTP request returns after
durable execution is queued and the browser polls the deployment record, so closing the tab cannot terminate a build or
strand it solely because the initiating request disconnected. The Workflow does not automatically retry external
provisioning or publish side effects.

The app tracks the latest AI SDK v6 peer line because the current Cloudflare Agents SDK and `workers-ai-provider` releases declare v6 as their supported AI SDK integration surface.

## User Cloudflare Integration

Generated applications use a server-owned deployment workflow:

1. The browser runs stack verification, type checking, build, and lint without invoking Wrangler production deployment.
2. It uploads an immutable tar.gz snapshot to `POST /api/deployments/plan`, excluding dependencies, build output, and
   all supported secret-file names.
3. The Worker derives the resource plan and stores its SHA-256 digest in D1.
4. The signed-in owner explicitly approves that digest through `POST /api/deployments/:id/approve`.
5. The server rebuilds in an egress-restricted Cloudflare Sandbox, then a fresh publish sandbox uses a short-lived,
   plan-bound proxy token while the real Cloudflare credential remains in the Worker.
6. The generated Worker, D1, R2, Durable Object, and Workers AI binding are created in the OAuth-selected user account,
   so Cloudflare meters them directly to that account.

The approval endpoint requires an unchanged active Cloudflare connection and explicit acknowledgement that Cloudflare
bills the user for infrastructure and inference. It also records that Workers Paid is not automatically enabled. Never
route generated-app deployment through Ghostbuild's root Wrangler credentials.

The default adapter remains fail-closed when the OAuth client bindings are absent. The unpublished Cloudflare/Stripe
Orchestrator transport is optional future work for users who do not already have a Cloudflare account; it is not needed
for direct billing to an OAuth-connected account. Temporary Wrangler claim deployments are not a production substitute
because they are time-limited and do not support the full generated-app stack.

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
