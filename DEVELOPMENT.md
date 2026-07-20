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

`pnpm run verify:licenses` checks every installed production dependency against the reviewed license-expression
allowlist in `scripts/production-license-policy.json` and requires the exact-version
`public/THIRD_PARTY_LICENSES.txt` artifact to be current. Run `pnpm run licenses:generate` after a production dependency
change. `pnpm run sbom:production` emits the same lockfile-bound inventory as deterministic SPDX 2.3 JSON; redirect it
to a release artifact when needed instead of committing a generated copy. These automated checks support license
diligence but do not replace legal review.

The generated-app template keeps an independent inventory at
`template/public/THIRD_PARTY_LICENSES.txt`. Run `pnpm --dir template run licenses:generate` when its production
dependency graph changes. Template builds verify both freshness and inclusion in the deployable client output.

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

Client source maps are generated for internal diagnosis but excluded from the static asset upload by the build-generated
`dist/client/.assetsignore`, following Cloudflare's
[static asset ignore contract](https://developers.cloudflare.com/workers/static-assets/binding/#ignoring-assets).
Worker source maps remain private Cloudflare uploads through
[`upload_source_maps`](https://developers.cloudflare.com/workers/observability/source-maps/). The `verify:static-assets`
check fails if either side of that policy drifts; bundle size accounting excludes the same non-deployable client maps.

## Deployment

```bash
export CLOUDFLARE_OAUTH_CLIENT_ID='<production OAuth client id>'
pnpm run deploy
```

The deploy pipeline validates the repository and confirms that its clean Git commit exactly identifies the build before
any Cloudflare resource, bookmark, or migration mutation. The preflight also rejects ignored root `.env*`, `.dev.vars*`,
and `*.vars` files because Vite or Wrangler could otherwise consume uncommitted build inputs. It then provisions
Cloudflare resources, verifies production configuration,
records a D1 recovery bookmark, applies migrations, publishes the Worker with the exact current 40-character Git commit
ID, and verifies that same commit locally and from multiple regions. A failed publish stops before live verification.
The production GitHub Actions workflow performs the same steps on `main`.

### Backup-quota rollout

`CHAT_BACKUP_STORAGE_QUOTA_MODE` is intentionally staged. Deploy migration `0020` with `shadow`, allow the scheduled
reconciler to complete at least two discovery passes and replace every estimated object size, then change the value to
`enforce` in a separately validated deployment. Before enforcement, confirm `backfill_completed_at` is non-null, no
`chat_backup_objects` rows remain with `size_source = 'estimated'`, and no expired pending admission remains. Byte,
object, and tenant-wide upload/clone request limits are exact D1 admission controls; `CHAT_BACKUP_RATE_LIMITER` is only
an early edge-shedding layer.

If migration or rollout verification fails, stop before publishing or enforcement and use the D1 Time Travel bookmark
printed by the deploy pipeline to plan recovery. Never infer quota readiness from a successful Worker upload alone.

Generated applications deploy through the server-owned workflow in
`app/lib/.server/cloudflare/deployment-workflow.ts`. Never route a user's deployment through Ghostbuild's own
Cloudflare credentials. AppAgent projects provision `DB` for application data and a distinct `AGENT_SECURITY_DB` for
Agent sessions, retention state, and inference accounting. Deployment readback must attest both database identifiers
and the complete server-owned security baseline before the deployment is considered successful.

## Historical Evaluations

Reproducible, dated agent and prompt-cache experiments live in `scripts/evaluations/`. They are evidence, not current
architecture requirements.
