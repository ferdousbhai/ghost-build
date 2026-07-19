# Development

Ghostbuild is developed as a TanStack Start app deployed to Cloudflare Workers.

## One-Time Setup

```bash
nvm install
nvm use
npm install -g pnpm@11.14.0
pnpm install
```

Provision the Cloudflare resources used by production deployments:

```bash
pnpm run provision:production
```

The provision step creates or reuses the configured D1 database and R2 bucket, then writes the non-secret D1 `database_id` into `wrangler.jsonc`.
The checked-in root ID identifies Ghostbuild's production database. Before deploying a fork to another Cloudflare
account, replace it with `00000000-0000-0000-0000-000000000000`; provisioning intentionally refuses to silently replace
a non-placeholder ID that is absent from the active account.

## Production Runtime Configuration

Configure runtime secrets as Cloudflare Worker bindings. Do not store secret values in local env files. Generated-project writes to `.env`, `.env.*`, `.envrc`, `.dev.vars`, and `.dev.vars.*` files are blocked.
The root `wrangler.jsonc` declares the three required production secret names in `secrets.required` and keeps static,
non-secret configuration in source control. The environment-specific `CLOUDFLARE_OAUTH_CLIENT_ID` is a required deploy
input: set it in the current process for local deploys and as a protected GitHub production-environment variable for CI.
The deploy wrapper validates and passes it to Wrangler explicitly, so production does not depend on dashboard-preserved
variables or `keep_vars`.

Builder inference uses only the OAuth-selected user's Cloudflare account. The root Worker intentionally has no `AI`
binding or operator-funded inference fallback. Use Wrangler OAuth for local production deploys.
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` are CI deploy credentials only; configure them as GitHub Actions
secrets for Wrangler authentication, not as Worker runtime secrets.

User-account connection uses Cloudflare's public OAuth Authorization Code flow with PKCE. Create a server-side OAuth
client in **Manage Account → OAuth clients**, register
`https://<ghostbuild-origin>/connect/return`, verify the client domain, and make the client public. Ghostbuild uses the
standard top-level GET authorization-code callback. The one-time server-side state and PKCE verifier bind the callback
to its authorization attempt. After Cloudflare returns the user identity and exactly one selected account, Ghostbuild
creates the local opaque session and encrypted account connection together. Cloudflare OAuth is the only login path.
Configure response type **Code**, grant types **Authorization Code** and **Refresh Token**, and token authentication
method **Client Secret Basic**. Enable the OpenID, Profile, and Email identity scopes, then select only the account permissions needed by the generated stack: Account Settings Read, Workers Scripts
Write, D1 Write, Workers R2 Storage Write, and Workers AI Read. Cloudflare's live OAuth scope catalog currently assigns
these IDs: `account-settings.read`, `workers-scripts.write`, `d1.write`, `workers-r2.write`, and `ai.read`. Configure
`openid profile email account-settings.read workers-scripts.write d1.write workers-r2.write ai.read` as the
space-delimited binding. Cloudflare adds the protocol-level `offline_access` scope to clients
that enable the Refresh Token grant. Do not include it in the resource-scope binding; Ghostbuild appends it to each
authorization request so Cloudflare issues a refresh token. Ghostbuild fails closed when the token response does not
include one because an expiring access token would eventually break deployments and connected-account inference.

Cloudflare creates OAuth clients as private. Before promoting the client, add a logo and a `ghostbuild.dev` client URL,
then complete Cloudflare's DNS TXT ownership verification for that domain. Promotion to public is permanent, so confirm
the production callback, client URL, metadata, and least-privilege scopes before changing visibility:

- `CLOUDFLARE_OAUTH_CLIENT_ID`
- `CLOUDFLARE_OAUTH_SCOPES`
- `CLOUDFLARE_OAUTH_CLIENT_SECRET` (Worker secret)

Access and refresh tokens are encrypted before D1 persistence. Expired access tokens are refreshed server-side and
rotated in the encrypted credential record. OAuth initiation is limited by the dedicated
`CLOUDFLARE_OAUTH_START_RATE_LIMITER` binding (10 attempts per 60 seconds per Cloudflare location and source key).
The scheduled maintenance handler prunes bounded batches of expired OAuth states and app sessions, plus encrypted
credential rows that have remained unreferenced for at least 24 hours.

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

The deployment sandbox image is pinned in `Dockerfile.sandbox`. Its Wrangler dependency is installed from the standalone
`sandbox-tools/pnpm-lock.yaml` with `--frozen-lockfile`; update that manifest and lockfile together. Building or dry-running
a container update requires a running Docker-compatible daemon. The sandbox denies internet access by default and never
receives the decrypted user Cloudflare credential.

Approved deployments are started through the `ghostbuild-deployments` Workflow binding. The HTTP request returns after
durable execution is queued and the browser polls the deployment record, so closing the tab cannot terminate a build or
strand it solely because the initiating request disconnected. The Workflow does not automatically retry external
provisioning or publish side effects.

The app tracks the latest AI SDK v6 peer line because the current Cloudflare Agents SDK and `workers-ai-provider` releases declare v6 as their supported AI SDK integration surface.

## User Cloudflare Integration

Generated applications use a server-owned deployment workflow:

1. The browser uploads an immutable ZIP source snapshot to `POST /api/deployments/plan`, excluding dependencies, build output, and
   all supported secret-file names.
2. The Worker derives the resource plan and stores its SHA-256 digest in D1.
3. The signed-in owner explicitly approves that digest through `POST /api/deployments/:id/approve`.
4. The server installs, verifies, type-checks, lints, and builds in an egress-restricted Cloudflare Sandbox. A fresh
   publish sandbox then uses a short-lived,
   plan-bound proxy token while the real Cloudflare credential remains in the Worker.
5. The generated Worker, D1, R2, Durable Object, and Workers AI binding are created in the OAuth-selected user account,
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

Read-only sub-agents are intentionally absent from the production runtime because the paired evaluation did not show a
quality gain worth the added latency and tokens. To reproduce the fixed explorer/verifier comparison, start its isolated
remote-dev Worker and POST once to the local URL it prints:

```bash
pnpm exec wrangler dev --remote --config scripts/evaluations/read-only-subagents.wrangler.jsonc
curl --request POST 'http://localhost:8787?case=0'
```

The response reports exact-match success, end-to-end latency, token usage, and model-price cost for the single-agent
baseline and the child-assisted path. Run cases `0` through `3`; evaluating one case per request stays below remote-preview
request timeouts. Do not add production delegation based only on unit tests.

To reproduce the Workers AI prefix-cache benchmark:

```bash
pnpm exec wrangler dev --remote --config scripts/evaluations/prompt-cache.wrangler.jsonc
curl --request POST http://localhost:8787
```

This benchmark changes the final user suffix after warming a large stable prefix and verifies the new answer. Treat only
a positive provider-reported cached-token count as a cache hit; latency alone is not hit evidence. The measured result
and current limitation are recorded in `scripts/evaluations/prompt-cache-2026-07-16.md`.

## Deployment

Production deploys run from the `Production Deploy` GitHub Actions workflow on pushes to `main` and manual `workflow_dispatch` runs. Configure `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` as GitHub Actions secrets for deploy authentication, and configure `CLOUDFLARE_OAUTH_CLIENT_ID` as a protected production-environment variable. The final publish step uses Cloudflare's official Wrangler GitHub Action and injects the OAuth client id and Git commit SHA into that Worker version. After a stabilization window, CI requires consecutive version checks from its runner and matching checks from Globalping probes in the United States, Germany, and Japan. Each check records the Cloudflare Ray ID and verifies the native Worker version ID, commit SHA, and non-cacheable response policy.

The canonical production origin is `https://ghostbuild.dev`. Its Wrangler route is a Custom Domain and `workers_dev` stays disabled. App navigation responses must preserve `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless`; without both, `window.crossOriginIsolated` is false and WebContainer boot is intentionally skipped.

```bash
export CLOUDFLARE_OAUTH_CLIENT_ID='<production OAuth client id>'
pnpm run deploy
```

The deploy command runs the complete validation pipeline, provisions required Cloudflare resources, verifies production Cloudflare config, applies production D1 migrations with `wrangler d1 migrations apply ghostbuild --remote`, and publishes the Worker with Wrangler. Provisioning uses the active Wrangler auth session locally and CI-provided Cloudflare secrets in GitHub Actions.

## Template Work

Generated apps are created from `template/`. After changing the template, rebuild the bootstrap snapshot:

```bash
pnpm run rebuild-template
```

## Public Release Controls

Before changing the GitHub repository to public, complete the repository-host controls that cannot be expressed in this
checkout:

- Enable private vulnerability reporting, Dependabot alerts, secret scanning with push protection, and code scanning.
- Protect `main` with a ruleset that requires the CI workflow, blocks force pushes and deletion, and applies to administrators.
- Restrict the `production` environment to protected `main` deployments and require review if the release policy calls for it.
- Configure `CLOUDFLARE_OAUTH_CLIENT_ID` as a non-secret variable in the protected `production` environment.
- Set the repository homepage to `https://ghostbuild.dev`, add relevant Cloudflare/TanStack topics, and confirm GitHub detects
  the canonical Apache-2.0 `LICENSE` plus `NOTICE` attribution.
- Verify the security-advisory contact link from a signed-out browser before announcing the repository.
