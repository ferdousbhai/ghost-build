# Contributing

Ghostbuild is focused on a Cloudflare + TanStack stack: TanStack Start, TanStack Router, TanStack Query, TanStack DB, Cloudflare Workers, Workers AI, D1, R2, and Cloudflare Agents.

Please keep changes aligned with that surface area. New model providers should use Workers AI only.

Before submitting changes, run:

```bash
pnpm run typecheck
pnpm run build
pnpm run test
pnpm run lint
```

For local setup, see [DEVELOPMENT.md](DEVELOPMENT.md).
