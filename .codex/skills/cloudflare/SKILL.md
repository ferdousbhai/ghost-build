---
name: cloudflare
description: Project-scoped Cloudflare platform skill for Ghost Coder agents building and deploying Worker apps.
---

# Cloudflare Skill

Use current Cloudflare docs and the Cloudflare API MCP server before implementing platform behavior.

## MCP

- Server name: `cloudflare-api`
- URL: `https://mcp.cloudflare.com/mcp`
- Do not add product-specific MCP servers.

## Scope

Default to Cloudflare Workers, Agents SDK, Think API, D1, R2, Durable Objects, AI Gateway, DNS, domains, and Wrangler.

## Rules

- Generated user apps deploy as Cloudflare Workers.
- Use Cloudflare/Stripe agent flows for account funding, domains, and paid Cloudflare actions.
- Never store raw card data.
- Keep the user's OpenAI API key in browser storage only.
- Ask for explicit confirmation before paid or destructive Cloudflare actions.
