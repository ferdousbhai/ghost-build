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

- Wrangler authentication for local deploys, or the shared `account-workers-builds-production` build token in Workers
  Builds
- `CLOUDFLARE_OAUTH_CLIENT_ID` in the deploy environment
- the Worker secrets declared by `wrangler.jsonc`

The OAuth client callback is `https://<deployment-origin>/connect/return`. Keep its permissions aligned with
`CLOUDFLARE_OAUTH_SCOPES` in `wrangler.jsonc`.

`workers-builds.production.json` is the reviewed source-of-truth contract for Cloudflare dashboard build settings. It
is verified in `pnpm run validate`; Cloudflare does not read it automatically. Mirror it in the `ghostbuild` Worker's
Build settings:

- connect `ferdousbhai/ghostbuild`, production branch `main`, with non-production builds disabled
- set the build command to `pnpm run workers-builds:build` and the deploy command to
  `pnpm run workers-builds:deploy`
- use `/` as the root directory, include all paths, and enable build caching
- select `account-workers-builds-production`
- configure `NODE_VERSION=26.3.0`, `PNPM_VERSION=11.14.0`, `SKIP_DEPENDENCY_INSTALL=1`, and the non-secret
  `CLOUDFLARE_OAUTH_CLIENT_ID`

The shared token must retain access to deploy Workers and Containers and to read or update the production D1 and R2
resources used by the release checks and migrations. Do not add token credentials to source or build variables.

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

Pushes to `main` are built and deployed by Cloudflare Workers Builds. The build command installs the locked dependency
graph, verifies the pinned toolchain, runs the complete validation pipeline, and rejects generated-file drift. The
deploy command accepts only a Workers Builds checkout of the exact `main` commit and then runs the production release.

Workers Builds does not provide the Docker daemon Wrangler needs to build `Dockerfile.sandbox`. Production therefore
uses the immutable Cloudflare Registry digest recorded in both `wrangler.jsonc` and `workers-builds.production.json`.
Validation hashes the Dockerfile and its copied `sandbox-tools` inputs so a Container source change cannot silently
reuse the old image. To release a Container change, build and push it from an approved Docker-capable environment, then
update the image digest and `sourceSha256` together before merging.

For a deliberate local fallback:

```bash
export CLOUDFLARE_OAUTH_CLIENT_ID='<production OAuth client id>'
pnpm run deploy:production
```

The deploy pipeline validates the repository and confirms that its clean Git commit exactly identifies the build before
any Cloudflare resource, bookmark, or migration mutation. The preflight also rejects ignored root `.env*`, `.dev.vars*`,
and `*.vars` files because Vite or Wrangler could otherwise consume uncommitted build inputs. The steady-state release
checks that the declared Cloudflare resources already exist, verifies production and Workers Builds configuration,
records a D1 recovery bookmark, applies migrations, publishes the Worker with the exact current 40-character Git commit
ID, and verifies that same commit locally and from multiple regions. A failed publish stops before live verification.
The bookmark output includes a machine-readable receipt with the commit and Workers Builds UUID.

Run `pnpm run provision:production` separately when bootstrapping production resources or intentionally reconciling
their checked-in identifiers. GitHub Actions remains responsible for pull-request and branch validation, but it no
longer holds or invokes the production deployment path.

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
