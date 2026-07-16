export function generateReadmeContent(description: string) {
  return `# ${description}

This project was built with Ghostbuild for Cloudflare Workers. TanStack Start is the default framework for full web applications; focused Worker handlers can run directly without framework abstractions.

## Stack

- TanStack Start and TanStack Router for browser application routes and SSR
- React
- Cloudflare Workers
- Cloudflare D1
- Cloudflare R2
- Workers AI
- Cloudflare Agents / Durable Objects with \`@cloudflare/ai-chat\`
- Wrangler

## Validation

\`\`\`sh
pnpm run dev
pnpm run preview
pnpm run generate-routes
pnpm run cf-typegen
pnpm run verify:stack
pnpm run typecheck
pnpm run build
pnpm run lint
\`\`\`

## Deployment

Use Wrangler OAuth for local production deploys, or configure \`CLOUDFLARE_ACCOUNT_ID\` and \`CLOUDFLARE_API_TOKEN\` as GitHub Actions secrets for CI authentication, then run:

\`\`\`sh
pnpm run deploy
\`\`\`

The deploy script verifies stack alignment, regenerates TanStack routes and Cloudflare binding types, typechecks the Worker, provisions required Cloudflare resources, verifies production Cloudflare config, builds the Worker, runs production linting, applies production D1 migrations with \`wrangler d1 migrations apply --remote\`, and deploys with Wrangler. Provisioning writes the non-secret D1 \`database_id\` into \`wrangler.jsonc\` after creating or finding the production D1 database.

Workers AI uses the Cloudflare \`AI\` binding and does not need model-provider API keys. Runtime secrets and variables belong in Cloudflare Worker bindings, configured with \`wrangler secret put NAME\` or Cloudflare dashboard Worker settings. Do not store secret values in local env files or source code.
The \`dev\` and \`preview\` scripts are for local/WebContainer preview only. Production deploys still go through \`pnpm run deploy\`.
Agent classes should set \`static override options = { sendIdentityOnConnect: false }\` when instance names can contain chat IDs, user IDs, or session IDs.
Keep Agent chat behavior explicit with \`messageConcurrency = "queue"\`, \`chatRecovery\`, and \`options?.abortSignal\` passed through to \`streamText\`. Configure \`waitForMcpConnections\` when the Agent uses MCP servers.
For production Agent observability, use Agents diagnostics-channel events and attach a Cloudflare Tail Worker when structured Agent RPC, chat, recovery, state, schedule, workflow, or MCP events need collection.
Keep production observability explicit in \`wrangler.jsonc\`: enable logs and traces, set logs \`head_sampling_rate\` to \`0.6\`, and set traces \`head_sampling_rate\` to \`0.05\` unless your production volume requires different sampling.
Worker API routes in \`src/server.ts\` receive bindings from the \`env\` argument. TanStack Start server functions that need Cloudflare bindings should import \`env\` from \`cloudflare:workers\` in server-only code.
Deploy directly to the production Cloudflare Worker; do not add staging targets or local dev-server deploy paths.
	`;
}
