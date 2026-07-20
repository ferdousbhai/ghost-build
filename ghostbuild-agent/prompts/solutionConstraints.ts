import { stripIndents } from '../utils/stripIndent.js';

export function solutionConstraints() {
  return stripIndents`
  <solution_constraints>
    <template>
      Work inside the existing Cloudflare project template at /home/project. Its package.json, node_modules, TanStack
      router, Cloudflare Worker entrypoint, AI/Agent bindings, D1/R2 resources, Tailwind setup, and live preview are
      already configured. The template is a starting point, not a requirement to express every request through
      TanStack. Preserve the useful architecture and modify package.json, vite.config.ts, or wrangler.jsonc only when
      the requested feature requires it.

      Key locations:
      - src/routes: TanStack Router pages and route loaders for browser applications
      - src/router.tsx: router setup
      - src/server.ts: Worker API routes, Agent routing, and exported Durable Objects
      - src/agents: Cloudflare Agent classes
      - migrations: D1 schema changes when durable relational storage is needed
      - src/workers-ai.shared.ts: shared Workers AI model constants
      - wrangler.jsonc: bindings, migrations, resources, and observability
    </template>

    <platform_and_framework_policy>
      Choose the smallest Cloudflare-native execution surface that fits the request. Use the official Cloudflare
      platform guidance available through lookupDocs before selecting products or architecture for Cloudflare work.

      For a user-facing web application, use TanStack Start and Router with React and Tailwind CSS when the user does
      not specify a framework. Prefer TanStack Start whenever its routing, SSR, server functions, and browser UI are a
      good fit. If the user explicitly requests a compatible framework or approach, follow that request.

      Do not add routes, React UI, SSR, or TanStack abstractions to a focused Worker request that does not need a full
      web application. HTTP APIs, webhooks, middleware, and similar fetch-handler scripts should use the Worker
      handler directly in src/server.ts. Automatic production deployment currently supports fetch-handler Workers;
      explain that scheduled, queue, email, and Tail handlers need deployment support before generating them. A Worker
      may expose a small HTML response without becoming a TanStack app. For
      a Worker-only project, set package.json ghostbuild.projectType to "worker", remove unused TanStack/React
      dependencies and route-generation steps, set its build script to a Wrangler dry-run targeting dist/worker, and
      set dev and preview to "wrangler dev", remove web-only provisioning and migration steps from deploy, and remove
      unused bindings from wrangler.jsonc. Then call npmInstall with mode "sync-lockfile" to synchronize
      pnpm-lock.yaml. Keep the marker absent (or set it to "web_app") for a TanStack
      browser application.

      Use only Cloudflare platform primitives for backend capabilities: Workers AI,
      Agents/Durable Objects, D1, R2, KV, Queues, Vectorize, and Cloudflare Email where appropriate. Do not introduce
      Convex, Remix, non-Cloudflare AI providers, or a second backend platform.

      Default coding-agent model: @cf/zai-org/glm-5.2 via the env.AI binding. Keep its id centralized in
      src/workers-ai.shared.ts. Chat Agents use AIChatAgent/useAgentChat, convertToModelMessages, pruneMessages,
      queue concurrency, explicit MCP startup timeout, abort-signal propagation, and sendIdentityOnConnect: false when
      instance names contain private identifiers. Use Agents diagnostics events and Cloudflare Tail Workers for
      production Agent observability.
    </platform_and_framework_policy>

    <runtime_and_data>
      Worker handlers receive bindings through env. Server functions needing bindings import env from
      cloudflare:workers in server-only code. Never rely on Node-only APIs in Worker handlers.

      When using TanStack Start, remember that it renders on the server. Keep window, document, storage, layout APIs,
      and hydration-sensitive values out of module evaluation, render paths, and useState initializers; access them
      from guarded effects.

      Prefer local React state for simple prototypes unless persistence, authentication, realtime sync, uploads, AI,
      or backend data is requested. For durable data, choose the Cloudflare primitive that matches the access pattern.

      Configure production secrets with Wrangler or the Cloudflare dashboard. Never commit secret values or create
      local secret files. Keep production observability explicit in wrangler.jsonc, with logs and traces enabled and
      the template sampling rates unless the user requests different rates.
    </runtime_and_data>

    <source_quality>
      Keep generated code and default UI copy ASCII unless non-ASCII text is requested. For browser UI, use
      lucide-react icons instead of raw decorative characters. Generate routes when TanStack routes change and binding
      types when Cloudflare configuration changes. Leave the project type-safe, lint-clean, buildable, and validated.
    </source_quality>
  </solution_constraints>
  `;
}
