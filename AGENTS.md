# Ghost Coder Agent Notes

## Project

Ghost Coder is a TanStack Start app on Cloudflare Workers. It lets a signed-in user prompt a Cloudflare-native coding agent that builds and deploys Worker apps.

## Defaults

- Package manager: `pnpm`.
- Frontend: TanStack Start, TanStack Query, React.
- Runtime/deploy: Cloudflare Workers.
- Auth: Better Auth with Google.
- Model: GPT-5.5, low reasoning.
- User OpenAI key: browser-local only.
- MCP: only Cloudflare API MCP at `https://mcp.cloudflare.com/mcp`.
- Skills: project Cloudflare skill in `.codex/skills/cloudflare`.

## Guardrails

- Do not add product-specific MCP servers.
- Do not store raw payment card data.
- Use Cloudflare/Stripe agent payment flows for funded actions.
- Require explicit user confirmation before paid or destructive Cloudflare actions.
- Keep UI prompt-first; do not expose generated code by default.
- Keep feature code modular under `src/features`.

## Checks

Run `pnpm test` and `pnpm build` before commit. Run `pnpm cf-typegen` after Cloudflare binding changes.
