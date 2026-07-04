import { stripIndents } from '../utils/stripIndent.js';

export function solutionConstraints() {
  return stripIndents`
  <solution_constraints>

    ${templateInfo()}

    <tanstack_start_cloudflare_guidelines>
      You MUST build apps with TanStack Start running on Cloudflare Workers.

      Core stack:
      - TanStack Start and TanStack Router for routing, SSR, route loaders, and server functions.
      - TanStack DB and TanStack Query for client-side data collections, live queries, optimistic writes, and API-backed sync.
      - Cloudflare Workers through Wrangler and the Cloudflare Vite plugin.
      - Workers AI through the \`AI\` binding on \`env.AI\`.
      - Cloudflare Agents through the \`agents\` package, Durable Objects, and \`routeAgentRequest\`.
      - Tailwind CSS for styling.

      Default coding-agent model:
      - Use Workers AI model \`@cf/zai-org/glm-5.2\` for coding-agent and AI code-generation features.
      - Keep the model id in \`src/workers-ai.shared.ts\` instead of hardcoding it in many places.
      - For chat UI, use the template \`AIChatAgent\` plus \`useAgentChat\` from \`@cloudflare/ai-chat/react\`.
      - For Agent chat model calls, convert the durable transcript with \`convertToModelMessages\`, then prune model context with \`pruneMessages\` before \`streamText\`.
      - Set \`maxPersistedMessages\` on \`AIChatAgent\` classes to bound SQLite transcript storage separately from model context.
      - Set \`messageConcurrency = "queue"\` for deterministic chat turn ordering unless the app intentionally needs latest, merge, drop, or debounce behavior.
      - Set \`waitForMcpConnections = { timeout: 10_000 }\` when an Agent may use MCP tools so startup waits are explicit instead of relying on package defaults.
      - Set \`static override options = { sendIdentityOnConnect: false }\` on Agent classes when instance names can contain chat IDs, user IDs, or session IDs, and use state updates rather than \`agent.identified\` as the readiness signal.
      - Pass \`options?.abortSignal\` through to \`streamText\` so stopped chat requests cancel Workers AI calls.
      - For direct non-chat Worker code, call \`await env.AI.run("@cf/zai-org/glm-5.2", { messages })\`.
      - For production Agent observability, rely on the Agents diagnostics-channel events and attach a Cloudflare Tail Worker when structured Agent RPC, chat, recovery, state, schedule, workflow, or MCP events need to be collected.

      Routing and files:
      - Put app routes in \`src/routes\` using TanStack Router file routes.
      - Keep the router setup in \`src/router.tsx\`.
      - Keep the custom Worker entrypoint in \`src/server.ts\`.
      - Add Agent classes in \`src/agents/*\` and export Durable Object classes from \`src/server.ts\`.
      - Update \`wrangler.jsonc\` when adding Worker bindings, Durable Object bindings, migrations, D1, R2, KV, Queues, or Vectorize.
      - Keep \`wrangler.jsonc\` production observability explicit: \`observability.enabled\`, \`observability.logs.enabled\`, and \`observability.traces.enabled\` must be true, with logs \`head_sampling_rate\` set to 0.6 and traces \`head_sampling_rate\` set to 0.05 unless the user asks for different production sampling.

      Cloudflare runtime rules:
      - Worker code receives bindings through the \`env\` argument. Do not depend on browser globals or Node-only APIs in Worker handlers.
      - TanStack Start server functions that need Cloudflare bindings must import \`env\` from \`cloudflare:workers\` in server-only code.
      - Use Wrangler secrets or Cloudflare dashboard variables for production secrets. Do not commit secret values or write local secret files.
      - Use TanStack DB collections in \`src/db/*\` for client data models. Use \`@tanstack/react-db\` hooks such as \`useLiveQuery\` in React components.
      - Use \`@tanstack/query-db-collection\` when a collection syncs to Worker API routes through TanStack Query.
      - For persisted TanStack DB writes, use collection handlers such as \`onInsert\`, \`onUpdate\`, or \`onDelete\`, call \`collection.insert\`, \`collection.update\`, or \`collection.delete\`, and await \`tx.isPersisted.promise\`.
      - Do not use \`collection.utils.writeInsert\`, \`collection.utils.writeUpdate\`, or \`collection.utils.writeDelete\` for app mutations.
      - Use Durable Objects or Cloudflare Agents for durable per-agent state and realtime coordination.
      - Use D1 for relational data, R2 for file/object storage, KV for simple low-write key/value data, Queues for async jobs, and Vectorize for vector search when needed.
      - Keep generated backend code on Cloudflare Workers and Cloudflare developer platform primitives.

      Production commands:
      - Use \`pnpm run generate-routes\` after route changes when needed.
      - Use \`pnpm run cf-typegen\` after changing \`wrangler.jsonc\` bindings.
      - Use \`pnpm run verify:stack\` to reject Convex, Remix, or non-Workers-AI provider drift.
      - Use \`pnpm run typecheck\` before production deployment.
      - Use \`pnpm run build\` to verify the Cloudflare Worker build.
      - Use \`pnpm run lint\` before applying production migrations or deploying.
      - Use \`pnpm run deploy\` to provision required Cloudflare resources, apply remote D1 migrations, and deploy directly to the production Cloudflare Worker.
    </tanstack_start_cloudflare_guidelines>
  </solution_constraints>
  `;
}

function templateInfo() {
  return stripIndents`
  <template_info>
    The Ghostbuild WebContainer environment starts with a full-stack app template fully loaded at '/home/project',
    the current working directory. Its dependencies are specified in the 'package.json' file and installed
    in the 'node_modules' directory. You MUST use this template. This template uses:
    - TanStack Start + TanStack Router
    - TanStack DB + TanStack Query
    - React
    - Cloudflare Workers
    - Cloudflare D1 and R2 bindings
    - Workers AI
    - Cloudflare Agents
    - Tailwind CSS

    Important template files:

    <file path="package.json">
      Defines the TanStack Start, Cloudflare Workers, Agents, and Wrangler dependencies and scripts.
      Do not modify this file unless the user request requires a new dependency.
    </file>

    <file path="wrangler.jsonc">
      Defines the Cloudflare Worker entrypoint, compatibility flags, AI binding, Durable Object bindings,
      D1/R2 bindings, migrations, production observability sampling, and other Cloudflare resources. Update this file when adding Cloudflare bindings.
    </file>

    <file path="vite.config.ts">
      Configures the Cloudflare Vite plugin, TanStack Start plugin, Agents plugin, and React plugin.
      Do not rewrite this file unless a build error or explicit user request requires it.
    </file>

    <file path="src/server.ts">
      Custom Cloudflare Worker entrypoint. It handles API routes such as \`/api/decisions\`, routes Agent requests,
      exports Durable Object classes, and falls through to TanStack Start's server handler.
      Worker API route handlers receive bindings from the \`env\` argument.
    </file>

    <file path="worker-configuration.d.ts">
      Generated Cloudflare binding types. It declares the \`cloudflare:workers\` module used by server-only
      TanStack Start code to import configured bindings.
    </file>

    <file path="src/workers-ai.shared.ts">
      Shared Workers AI constants and response parsing helpers. It centralizes use of \`@cf/zai-org/glm-5.2\`
      without pulling server-only validation into the browser bundle.
    </file>

    <file path="src/agents/app-agent.ts">
      Example Cloudflare \`AIChatAgent\` with resumable chat, durable state, and callable methods.
      Use Agents diagnostics-channel events and Tail Workers for production Agent observability.
      Add new agent behavior here or in sibling files under \`src/agents\`.
    </file>

    <directory path="src/db/">
      TanStack DB collections and data-layer helpers. The starter includes a D1-backed query collection.
      Use query-backed collections for Worker API data and local-only collections only for ephemeral client data.
    </directory>

    <directory path="migrations/">
      D1 SQL migrations. Add schema changes here and apply them with the production deploy script.
    </directory>

    <directory path="src/routes/">
      TanStack Router file routes. Build the application UI and route-level logic here.
    </directory>

    <file path="src/styles.css">
      Global Tailwind CSS entrypoint and base styles.
    </file>
  </template_info>
  `;
}
