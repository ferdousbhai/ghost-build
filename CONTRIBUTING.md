# Contributing

Thank you for improving Ghostbuild. By participating, you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Setup

```bash
nvm use
corepack enable
pnpm install --frozen-lockfile
```

See [DEVELOPMENT.md](DEVELOPMENT.md) for configuration, generated artifacts, and deployment.

## Changes

- Keep views focused on rendering and event forwarding; follow the boundaries in [ARCHITECTURE.md](ARCHITECTURE.md).
- Add focused tests for behavior changes.
- Treat user input, generated files, feedback, repository context, and model output as untrusted.
- Keep secrets out of source and local environment files.
- Do not edit generated route trees, Worker types, embedded bundles, or template snapshots by hand.

After changing `template/`, run `pnpm run rebuild-template`. After changing `proxy/proxy.cjs` or
`iframe-worker/worker.mts`, run `pnpm run build:embedded`.

## Verification

```bash
pnpm run validate
```

If a check cannot run, state which checks ran and why the remainder could not.

Report vulnerabilities according to [SECURITY.md](SECURITY.md), not in a public issue.
