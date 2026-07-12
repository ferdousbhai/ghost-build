import { stripIndents } from '../utils/stripIndent.js';

export function solutionConstraints() {
  return stripIndents`
  <solution_constraints>
    <template>
      Work inside the existing full-stack template at /home/project. Its package.json, node_modules, TanStack router,
      Cloudflare Worker entrypoint, AI/Agent bindings, D1/R2 resources, Tailwind setup, and live preview are already
      configured. Preserve the template architecture and modify package.json, vite.config.ts, or wrangler.jsonc only
      when the requested feature requires it.

      Key locations:
      - src/routes: TanStack Router pages and route loaders
      - src/router.tsx: router setup
      - src/server.ts: Worker API routes, Agent routing, and exported Durable Objects
      - src/agents: Cloudflare Agent classes
      - migrations: D1 schema changes when durable relational storage is needed
      - src/workers-ai.shared.ts: shared Workers AI model constants
      - wrangler.jsonc: bindings, migrations, resources, and observability
    </template>

    <required_stack>
      Build with TanStack Start and Router on Cloudflare Workers, using React and Tailwind CSS. Use only Cloudflare
      platform primitives for backend capabilities: Workers AI,
      Agents/Durable Objects, D1, R2, KV, Queues, Vectorize, and Cloudflare Email where appropriate. Do not introduce
      Convex, Remix, non-Cloudflare AI providers, or a second backend platform.

      Default coding-agent model: @cf/zai-org/glm-5.2 via the env.AI binding. Keep its id centralized in
      src/workers-ai.shared.ts. Chat Agents use AIChatAgent/useAgentChat, convertToModelMessages, pruneMessages,
      queue concurrency, explicit MCP startup timeout, abort-signal propagation, and sendIdentityOnConnect: false when
      instance names contain private identifiers. Use Agents diagnostics events and Cloudflare Tail Workers for
      production Agent observability.
    </required_stack>

    <runtime_and_data>
      Worker handlers receive bindings through env. Server functions needing bindings import env from
      cloudflare:workers in server-only code. Never rely on Node-only APIs in Worker handlers.

      TanStack Start renders on the server. Keep window, document, storage, layout APIs, and hydration-sensitive values
      out of module evaluation, render paths, and useState initializers; access them from guarded effects.

      Prefer local React state for simple prototypes unless persistence, authentication, realtime sync, uploads, AI,
      or backend data is requested. For durable data, choose the Cloudflare primitive that matches the access pattern.

      Configure production secrets with Wrangler or the Cloudflare dashboard. Never commit secret values or create
      local secret files. Keep production observability explicit in wrangler.jsonc, with logs and traces enabled and
      the template sampling rates unless the user requests different rates.
    </runtime_and_data>

    <source_quality>
      Keep generated code and default UI copy ASCII unless non-ASCII text is requested. Use lucide-react icons instead
      of raw decorative characters. Generate routes and binding types after corresponding configuration changes, and
      leave the app type-safe, lint-clean, buildable, and validated.
    </source_quality>
  </solution_constraints>
  `;
}
