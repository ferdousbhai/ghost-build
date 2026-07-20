# Development

## Setup

```bash
nvm install
nvm use
corepack enable
pnpm install --frozen-lockfile
```

Node.js and pnpm versions are pinned in `.nvmrc` and `package.json`.

## Verification

Run the same complete pipeline used by CI:

```bash
pnpm run validate
```

Useful narrower checks are exposed as `validate:root`, `validate:agent`, `validate:template`, `test`, `test:workerd`,
`typecheck`, and `lint` scripts in `package.json`. Generated files produced by verification must leave the worktree
clean.

## Configuration

`wrangler.jsonc` is the source of truth for root Worker bindings, non-secret variables, and required secret names.
Configure secret values as Cloudflare Worker secrets; do not store them in source or local environment files.

The checked-in D1 ID belongs to Ghostbuild production. Before provisioning a fork in another account, replace it with
`00000000-0000-0000-0000-000000000000`. The provisioning script refuses to replace an unknown non-placeholder ID.

Production deployment requires:

- Wrangler authentication, or `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in CI
- `CLOUDFLARE_OAUTH_CLIENT_ID` in the deploy environment
- the Worker secrets declared by `wrangler.jsonc`

The OAuth client callback is `https://<deployment-origin>/connect/return`. Keep its permissions aligned with
`CLOUDFLARE_OAUTH_SCOPES` in `wrangler.jsonc`.

## Generated Artifacts

After editing the generated-application source:

```bash
pnpm run rebuild-template
```

After editing either embedded helper source:

```bash
pnpm run build:embedded
pnpm run build:embedded:check
```

Do not edit generated route trees, Worker binding types, embedded bundles, or template snapshots directly.

## Deployment

```bash
export CLOUDFLARE_OAUTH_CLIENT_ID='<production OAuth client id>'
pnpm run deploy
```

The deploy pipeline validates the repository, provisions Cloudflare resources, verifies production configuration,
records a D1 recovery bookmark, applies migrations, publishes the Worker, and verifies the live version. The production
GitHub Actions workflow performs the same steps on `main`.

Generated applications deploy through the server-owned workflow in
`app/lib/.server/cloudflare/deployment-workflow.ts`. Never route a user's deployment through Ghostbuild's own
Cloudflare credentials.

## Historical Evaluations

Reproducible, dated agent and prompt-cache experiments live in `scripts/evaluations/`. They are evidence, not current
architecture requirements.
