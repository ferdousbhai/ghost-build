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

The deploy script verifies stack alignment, regenerates TanStack routes and Cloudflare binding types, typechecks the Worker, provisions required Cloudflare resources, verifies production Cloudflare config, builds the Worker, runs production linting, applies both application and protected Agent-security D1 migrations, and deploys with Wrangler. Provisioning writes each non-secret D1 \`database_id\` into \`wrangler.jsonc\` after creating or finding the separate production databases.

After adding, removing, or upgrading a production dependency, run \`pnpm run licenses:generate\` before build or deploy. Build validation fails when \`public/THIRD_PARTY_LICENSES.txt\` does not match the current lockfile and installed production packages.

Workers AI is confined to the reviewed AppAgent boundary and does not need model-provider API keys. Keep non-secret configuration in \`wrangler.jsonc\`. Declare required secret names in \`secrets.required\`, then configure their values with \`wrangler secret put NAME\` or Cloudflare dashboard Worker settings. Do not store secret values in local env files or source code.
The \`dev\` and \`preview\` scripts are for local/WebContainer preview only. Production deploys still go through \`pnpm run deploy\`.
Agent classes should set \`static override options = { sendIdentityOnConnect: false }\` when instance names can contain chat IDs, user IDs, or session IDs.
The starter's random browser-session Agent name prevents accidental history sharing, but it is not authorization. Before a public production launch, authenticate and rate-limit Agent routes and derive tenant or user instance names from verified server-side identity rather than trusting a client-supplied path.
Keep Agent chat behavior explicit with \`messageConcurrency = "queue"\`, \`chatRecovery\`, and \`options?.abortSignal\` passed through to \`streamText\`. Configure \`waitForMcpConnections\` when the Agent uses MCP servers.
For production Agent observability, use Agents diagnostics-channel events and attach a Cloudflare Tail Worker when structured Agent RPC, chat, recovery, state, schedule, workflow, or MCP events need collection.
Keep production observability explicit in \`wrangler.jsonc\`: enable logs and traces, set logs \`head_sampling_rate\` to \`0.6\`, and set traces \`head_sampling_rate\` to \`0.05\` unless your production volume requires different sampling.
Generated TanStack routes and server functions should call \`getAppBindings()\` from \`@/app-bindings\` for application D1/R2 access. Do not import \`cloudflare:workers\` from generated source; AI, AppAgent, and \`AGENT_SECURITY_DB\` bindings are intentionally unavailable to generated routes.
Automatically deployed AppAgent projects reject dynamic \`import()\`, \`require()\`, \`eval()\`, and \`Function\` constructors in generated source.
Deploy directly to the production Cloudflare Worker; do not add staging targets or local dev-server deploy paths.
	`;
}
