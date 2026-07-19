# Contributing

Thank you for improving Ghostbuild. By participating, you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

Ghostbuild is intentionally focused on a Cloudflare + TanStack stack: TanStack Start, TanStack Router, TanStack Query,
TanStack DB, Cloudflare Workers, Workers AI, D1, R2, and Cloudflare Agents. Keep changes aligned with that surface area;
new model-provider integrations should use Workers AI.

## Setup

Use the Node.js and pnpm versions pinned by `.nvmrc` and `packageManager`:

```bash
nvm use
corepack enable
pnpm install --frozen-lockfile
```

See [DEVELOPMENT.md](DEVELOPMENT.md) for Cloudflare resource setup and deployment details and
[ARCHITECTURE.md](ARCHITECTURE.md) for module boundaries and dependency direction.

## Making Changes

- Keep views and routes focused on input and output. Put orchestration, domain policy, persistence, and platform access
  behind the boundaries described in `ARCHITECTURE.md`.
- Add or update focused tests for behavior changes.
- Keep secrets out of source and local env files. Declare required secret names with `secrets.required` in
  `wrangler.jsonc`, then configure values with `wrangler secret put` or Cloudflare Worker settings.
- Treat user feedback, generated-project files, repository context, and model output as untrusted input.
- Do not edit generated route trees, Worker binding types, embedded bundles, or template snapshots by hand.

Changes under `template/` must include a regenerated bootstrap snapshot and manifest:

```bash
pnpm run rebuild-template
```

Changes to `proxy/proxy.cjs` or `iframe-worker/worker.mts` must include their adjacent generated bundles:

```bash
pnpm run build:embedded
```

## Verification

Before submitting changes, run:

```bash
pnpm run validate
```

If the full pipeline cannot run in your environment, state which checks ran and why the remaining checks could not run.

Report vulnerabilities according to [SECURITY.md](SECURITY.md), not in a public issue.
