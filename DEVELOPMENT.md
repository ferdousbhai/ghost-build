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

Useful narrower checks are `validate:root`, `validate:agent`, `validate:template`, `test`, `test:workerd`, `typecheck`,
and `lint`. Generated files produced by verification must leave the worktree clean.

`pnpm run verify:licenses` checks installed production dependencies against the reviewed license-expression allowlist
and verifies `public/THIRD_PARTY_LICENSES.txt`. Run `pnpm run licenses:generate` after a root production dependency
change. `pnpm run sbom:production` prints a deterministic SPDX 2.3 inventory suitable for a release artifact.

The generated-app template has an independent dependency graph and license artifact. Run
`pnpm --dir template run licenses:generate` after changing its production dependencies. These automated checks support
license diligence but do not replace legal review.

## Configuration

`wrangler.jsonc` is the source of truth for the control-plane Worker. It contains one D1 binding for identity,
authentication, encrypted Cloudflare credentials, connection metadata, and user-runtime discovery. Configure the two
declared secret values in Cloudflare; never store them in source or local environment files.

The checked-in D1 ID belongs to Ghostbuild production. Before provisioning a fork in another account, replace it with
`00000000-0000-0000-0000-000000000000`. The provisioner refuses to replace an unknown non-placeholder ID.

The OAuth callback is `https://<deployment-origin>/connect/return`. Keep its permissions aligned with
`CLOUDFLARE_OAUTH_SCOPES` in `wrangler.jsonc`. Those permissions let Ghostbuild create a workspace runtime in the
connected user's account; they do not add customer storage or compute to the Ghostbuild account.

`workers-builds.production.json` is the reviewed contract for Cloudflare dashboard build settings. Cloudflare does not
read it automatically. Mirror it in the `ghostbuild` Worker's Builds settings:

- connect `ferdousbhai/ghost-build`, production branch `main`, with non-production builds enabled
- set the build command to `pnpm run workers-builds:build` and deploy command to `pnpm run workers-builds:deploy`
- set non-production deploys to `pnpm run workers-builds:preview`
- use `/` as the root, include all paths, and enable build caching
- select `account-workers-builds-production`
- configure the pinned `NODE_VERSION`, `PNPM_VERSION`, `SKIP_DEPENDENCY_INSTALL=1`, and
  `CLOUDFLARE_OAUTH_CLIENT_ID`

The Workers Builds token needs only the permissions required to deploy the control-plane Worker, read its deployment,
and manage the control-plane D1 migrations. User workspace and generated-application resources are provisioned with the
connected user's authorization.

## Generated Artifacts

After editing `template/`:

```bash
pnpm run rebuild-template
```

Do not edit generated route trees, Worker binding types, `app/generated/user-workspace-runtime.generated.ts`, or the
generated Builder template module directly.

`template/scripts/lib/project-policy/generated-project-dependency-policy.json` is the single machine-readable source
for generated-project pnpm cooling, lifecycle-build approvals, and security overrides. Both the browser write guard and
the root/template verifiers import it. The repository-only early-release exception for the pinned Computer preview is
an explicitly named profile difference; generated projects do not inherit it.

Client source maps are generated for internal diagnosis but excluded from the static upload by
`dist/client/.assetsignore`, following Cloudflare's
[static asset ignore contract](https://developers.cloudflare.com/workers/static-assets/binding/#ignoring-assets).
Worker source maps remain private Cloudflare uploads through
[`upload_source_maps`](https://developers.cloudflare.com/workers/observability/source-maps/). The validation pipeline
checks both sides of that policy.

## User Workspace Runtime

`pnpm run generate:user-workspace-runtime` bundles the source in `user-workspace-runtime/` together with its migrations.
The control plane deploys that bundle into each connected user's Cloudflare account and provisions its D1 database,
`BuilderAgent` Durable Objects, `ProjectWorkspace` Durable Objects, Worker Loader binding, and Container application
there. The R2 permission is retained for generated applications that request an R2 binding; project workspace bytes do
not use an R2 backup bucket.

There is intentionally no migration path from retired Ghostbuild-owned project or chat storage. A new deployment of
the control plane bootstraps its current D1 schema; each newly provisioned user runtime bootstraps the current
`user-workspace-migrations/` schema. Existing user runtimes are replaced when their recorded bundle digest differs from
the current digest.

Cloudflare Computer's SQLite VFS in `ProjectWorkspace` owns the current project. Lightweight shell commands operate on
that VFS through the worker-shell backend; dependency installation, validation, preview, and generated-app deployment
use the container backend and its FUSE projection of the same files. No ZIP, `DirectoryBackup`, or project copy passes
through Ghostbuild.

## Deployment

Cloudflare Workers Builds validates every push. Non-production branches upload an undeployed Worker version. A push to
`main` runs the production deploy command only from the exact Workers Builds checkout, applies control-plane D1
migrations, publishes with the exact 40-character commit ID, and verifies that commit from multiple regions.

Production source deploys are intentionally accepted only from Cloudflare Workers Builds. For an emergency rollback
from a clean checkout of current `main`, inspect and promote an immutable version:

```bash
pnpm exec wrangler versions view '<version-id>' --name ghostbuild --json
pnpm exec wrangler rollback '<version-id>' --name ghostbuild --message '<reason>'
```

Rollback changes the Worker version but not D1 data. If a release also changed control-plane data, use the recovery
bookmark recorded by the release pipeline. Run `pnpm run provision:production` separately only when bootstrapping the
control-plane D1 or intentionally reconciling its checked-in identifier.

Generated applications deploy independently inside the user workspace runtime. AppAgent projects provision `DB` for
application data and `AGENT_SECURITY_DB` for Agent sessions, retention, and inference accounting. Deployment readback
must attest both databases and the complete server-derived security baseline.

## Historical Evaluations

Experiment conclusions that still constrain the product are summarized in `scripts/evaluations/DECISIONS.md`. The
repository does not ship or support one-off remote evaluation Workers. Run launch-capacity measurements against the
exact release candidate in isolated staging infrastructure and retain provider telemetry with the release evidence.
