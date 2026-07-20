export const tanstackStart = `
TanStack Start on Cloudflare:
- Use file routes in src/routes and keep the router setup in src/router.tsx.
- Keep the Worker entrypoint in src/server.ts and import the Start handler from @tanstack/react-start/server-entry.
- Configure vite.config.ts with @cloudflare/vite-plugin using cloudflare({ viteEnvironment: { name: "ssr" } }) and @tanstack/react-start/plugin/vite.
- Keep wrangler.jsonc observability explicit for production: observability.enabled = true, observability.logs.enabled = true with head_sampling_rate 0.6, and observability.traces.enabled = true with head_sampling_rate 0.05.
- Worker API routes in src/server.ts receive Cloudflare bindings from the fetch(request, env) argument.
- TanStack Start server functions that need bindings should import { env } from "cloudflare:workers" from server-only code.
- Generate routes with pnpm run generate-routes after route changes.
- Generate Cloudflare binding types with pnpm run cf-typegen after wrangler.jsonc binding changes.
`;

export const tanstackQuery = `
TanStack Query:
- Create one QueryClient and provide it near the app root with QueryClientProvider.
- Use useQuery for server-backed reads and useMutation for writes to Worker API routes.
- Prefer explicit queryKey arrays that include resource identity and filters.
- Invalidate or update affected queries after successful mutations.
- When collection state should be live/queryable in components, pair TanStack Query with @tanstack/query-db-collection and TanStack DB.
`;

export const tanstackDb = `
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
`;
