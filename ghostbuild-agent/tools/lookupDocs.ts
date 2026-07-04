import type { Tool } from 'ai';
import { z } from 'zod';

export const lookupDocsParameters = z.object({
  docs: z
    .array(z.enum(['tanstackStart', 'tanstackQuery', 'tanstackDb', 'workersAi', 'agents', 'cloudflareStorage']))
    .describe('List of TanStack or Cloudflare docs to look up for the features being implemented.'),
});

export function lookupDocsTool(): Tool {
  return {
    description:
      'Lookup documentation snippets for supported stack features. Valid docs are: `tanstackStart`, `tanstackQuery`, `tanstackDb`, `workersAi`, `agents`, and `cloudflareStorage`.',
    inputSchema: lookupDocsParameters,
  };
}

export const docs = {
  tanstackStart: `
TanStack Start on Cloudflare:
- Use file routes in src/routes and keep the router setup in src/router.tsx.
- Keep the Worker entrypoint in src/server.ts and import the Start handler from @tanstack/react-start/server-entry.
- Configure vite.config.ts with @cloudflare/vite-plugin using cloudflare({ viteEnvironment: { name: "ssr" } }) and @tanstack/react-start/plugin/vite.
- Keep wrangler.jsonc observability explicit for production: observability.enabled = true, observability.logs.enabled = true with head_sampling_rate 0.6, and observability.traces.enabled = true with head_sampling_rate 0.05.
- Worker API routes in src/server.ts receive Cloudflare bindings from the fetch(request, env) argument.
- TanStack Start server functions that need bindings should import { env } from "cloudflare:workers" from server-only code.
- Generate routes with pnpm run generate-routes after route changes.
- Generate Cloudflare binding types with pnpm run cf-typegen after wrangler.jsonc binding changes.
`,
  tanstackQuery: `
TanStack Query:
- Create one QueryClient and provide it near the app root with QueryClientProvider.
- Use useQuery for server-backed reads and useMutation for writes to Worker API routes.
- Prefer explicit queryKey arrays that include resource identity and filters.
- Invalidate or update affected queries after successful mutations.
- When collection state should be live/queryable in components, pair TanStack Query with @tanstack/query-db-collection and TanStack DB.
`,
  tanstackDb: `
TanStack DB:
- Use @tanstack/db for collections and @tanstack/react-db for React live queries.
- Define collections in src/db/* with createCollection(...).
- Prefer @tanstack/query-db-collection when a collection syncs through TanStack Query-backed Worker API calls.
- Use localOnlyCollectionOptions only for local-only or ephemeral client state.
- Use useLiveQuery(collection) or useLiveQuery((q) => q.from({ items: collection })) in React components.
- For persisted writes, configure onInsert, onUpdate, or onDelete handlers on queryCollectionOptions.
- In persistence handlers, read transaction.mutations and call Worker API routes or TanStack Start server functions that persist to D1/R2.
- When a server function persists to Cloudflare resources, import { env } from "cloudflare:workers" in server-only code instead of using local env files.
- Call collection.insert, collection.update, or collection.delete from UI helpers, then await tx.isPersisted.promise before treating the write as saved.
- Do not use collection.utils.writeInsert, collection.utils.writeUpdate, or collection.utils.writeDelete for app mutations.
`,
  workersAi: `
Workers AI:
- Add an AI binding in wrangler.jsonc: "ai": { "binding": "AI" }.
- Worker handlers access it as env.AI.
- Use @cf/zai-org/glm-5.2 for coding-agent and app AI features.
- Example: await env.AI.run("@cf/zai-org/glm-5.2", { messages }).
- For chat UI, prefer the template AIChatAgent plus useAgentChat from @cloudflare/ai-chat/react instead of custom /api/ai routes.
`,
  agents: `
Cloudflare Agents:
- Use the agents package for durable agent identities and callable methods.
- For AI chat experiences, use @cloudflare/ai-chat AIChatAgent, streamText, convertToModelMessages, pruneMessages, and useAgentChat.
- Define Agent classes in src/agents/* and export Durable Object classes from src/server.ts.
- Configure Vite with agents/vite and TypeScript with agents/tsconfig.
- Route agent requests first in the Worker entrypoint with routeAgentRequest(request, env), before normal API routes and the TanStack Start handler.
- Add Durable Object bindings and new_sqlite_classes migrations in wrangler.jsonc.
- Use @callable methods for client-invoked Agent actions and this.setState for durable state updates.
- Keep the Agent transcript durable, but prune model context with pruneMessages before calling streamText.
- Set maxPersistedMessages to bound SQLite transcript storage independently from model context.
- Set messageConcurrency = "queue" for deterministic chat turn ordering unless the product intentionally needs latest/merge/drop/debounce semantics.
- Set waitForMcpConnections = { timeout: 10_000 } when an Agent may use MCP tools so startup waits are explicit instead of relying on package defaults.
- Set static override options = { sendIdentityOnConnect: false } when Agent instance names can contain chat IDs, user IDs, or session IDs, and use state updates rather than agent.identified for readiness.
- Pass options?.abortSignal through to streamText so a stopped chat request cancels the Workers AI call.
- For production Agent observability, use the Agents diagnostics-channel events and attach a Cloudflare Tail Worker when structured RPC, chat, recovery, state, schedule, workflow, or MCP events need to be collected.
`,
  cloudflareStorage: `
Cloudflare storage:
- Use D1 for relational data.
- Use R2 for object and file storage.
- Use KV for simple low-write key/value data.
- Use Queues for async jobs.
- Use Vectorize for vector search.
- Add bindings in wrangler.jsonc and read them from Worker env.
- In TanStack Start server functions, read configured bindings with import { env } from "cloudflare:workers".
`,
} as const;

export type DocKey = keyof typeof docs;
