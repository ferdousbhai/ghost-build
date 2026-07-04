export const cursorRulesContent = `# Ghostbuild Cloudflare App Rules

- Use TanStack Start and TanStack Router for routes and SSR.
- Keep Worker entrypoint code in src/server.ts.
- Use Cloudflare bindings through the Worker env object.
- In TanStack Start server functions, import env from cloudflare:workers from server-only code when bindings are needed.
- Use Workers AI through env.AI and prefer @cf/zai-org/glm-5.2 for coding-agent features.
- Use Cloudflare Agents and Durable Objects for durable agent state. For chat UI, prefer the template AIChatAgent with useAgentChat from @cloudflare/ai-chat/react.
- Set static override options = { sendIdentityOnConnect: false } when Agent instance names can contain chat IDs, user IDs, or session IDs, and use state updates rather than agent.identified for readiness.
- Keep Agent chat behavior explicit with maxPersistedMessages, messageConcurrency = "queue", waitForMcpConnections = { timeout: 10_000 }, chatRecovery, and options?.abortSignal passed through to streamText.
- For production Agent observability, use Agents diagnostics-channel events and attach a Cloudflare Tail Worker when structured Agent RPC, chat, recovery, state, schedule, workflow, or MCP events need collection.
- Update wrangler.jsonc when adding bindings, Durable Objects, migrations, D1, R2, KV, Queues, or Vectorize.
- Keep wrangler.jsonc production observability explicit: observability.enabled, observability.logs.enabled, and observability.traces.enabled should be true, with logs head_sampling_rate 0.6 and traces head_sampling_rate 0.05 unless production volume requires different sampling.
- Do not commit secret values or write local secret files. Use wrangler secret put NAME or Cloudflare dashboard Worker settings for production secrets and variables.
- Keep CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN as production deploy credentials only; do not use them as Worker runtime secrets.
- Keep backend code on Cloudflare Workers and Cloudflare developer platform primitives.
- Validate changes with pnpm run verify:stack, pnpm run typecheck, pnpm run build, and pnpm run lint.
- Deploy directly to the production Cloudflare Worker with pnpm run deploy. Do not add staging targets or local dev-server deployment paths.
`;
