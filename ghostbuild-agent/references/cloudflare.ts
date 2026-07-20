export const cloudflarePlatform = `
Official Cloudflare skill: cloudflare
Source: https://github.com/cloudflare/skills/tree/main/skills/cloudflare

Use for any Cloudflare development task. The official skill covers Workers, Pages, KV, D1, R2, Workers AI, Vectorize, Agents SDK, networking, security, and infrastructure-as-code.

Retrieval-first rule:
- Cloudflare APIs, limits, pricing, config fields, compatibility dates, and type signatures change. Prefer current Cloudflare docs, local node_modules types, and wrangler schema over pre-trained memory.
- When docs and local snippets disagree, trust the current docs.

Decision guide:
- Full browser application with routes, SSR, and server functions -> TanStack Start on Workers by default when the user does not specify a framework.
- HTTP API, webhook, middleware, or small custom edge script -> a direct Worker handler without an application framework.
- Scheduled task -> a Worker scheduled handler with Cron Triggers.
- Asynchronous event processing -> a Queue consumer or Workflow, depending on whether the work is message-driven or a durable multi-step job.
- Lightweight response rewriting at the edge -> Snippets when its product limits fit; otherwise a Worker.
- Relational data -> D1, or Hyperdrive for an existing external SQL database.
- Object/file storage -> R2.
- Key/value config, low-write settings, or sessions -> KV.
- Async processing -> Queues or Workflows.
- Vector search -> Vectorize.
- Stateful coordination, per-room/per-user state, WebSockets, or strong consistency -> Durable Objects or Agents SDK.
- LLM inference -> Workers AI binding when available.
- App-level AI agent behavior -> Agents SDK and AIChatAgent.
- Do not provision a product or introduce a framework merely because it exists in the starter template.
`;

export const cloudflareStorage = `
Cloudflare storage:
- Use D1 for relational data.
- Use R2 for object and file storage.
- Use KV for simple low-write key/value data.
- Use Queues for async jobs.
- Use Vectorize for vector search.
- Add bindings in wrangler.jsonc and read them from Worker env.
- In TanStack Start server functions, read configured bindings with import { env } from "cloudflare:workers".
`;

export const workersAi = `
Workers AI:
- Add an AI binding in wrangler.jsonc: "ai": { "binding": "AI" }.
- Worker handlers access it as env.AI.
- Use @cf/zai-org/glm-5.2 for coding-agent and app AI features.
- Example: await env.AI.run("@cf/zai-org/glm-5.2", { messages }).
- For chat UI, prefer the template AIChatAgent plus useAgentChat from @cloudflare/ai-chat/react instead of custom /api/ai routes.
`;

export const cloudflareAgentsSdk = `
Official Cloudflare skill: agents-sdk
Source: https://github.com/cloudflare/skills/tree/main/skills/agents-sdk
Docs: https://developers.cloudflare.com/agents/

Use when creating stateful AI agents, durable workflows, WebSocket apps, scheduled tasks, MCP servers, chat applications, voice agents, browser automation, or any feature using the Agents SDK.

Ghostbuild defaults:
- Use the agents package for durable agent identities and callable methods.
- For AI chat experiences, use @cloudflare/ai-chat AIChatAgent, streamText, convertToModelMessages, pruneMessages, and useAgentChat.
- Define Agent classes in src/agents/* and export Durable Object classes from src/server.ts.
- Configure Vite with agents/vite and TypeScript with agents/tsconfig.
- Route agent requests first in the Worker entrypoint with routeAgentRequest(request, env), before normal API routes and the TanStack Start handler.
- Add Durable Object bindings and new_sqlite_classes migrations in wrangler.jsonc.
- Use @callable methods for client-invoked Agent actions and this.setState for durable state updates.
- Keep the Agent transcript durable, but prune model context with pruneMessages before calling streamText.
- Set messageConcurrency = "queue" for deterministic chat turn ordering unless the product intentionally needs latest/merge/drop/debounce semantics.
- Set waitForMcpConnections = { timeout: 10_000 } when an Agent may use MCP tools so startup waits are explicit instead of relying on package defaults.
- Set static override options = { sendIdentityOnConnect: false } when Agent instance names can contain chat IDs, user IDs, or session IDs, and use state updates rather than agent.identified for readiness.
- Pass options?.abortSignal through to streamText so a stopped chat request cancels the Workers AI call.
- For production Agent observability, use the Agents diagnostics-channel events and attach a Cloudflare Tail Worker when structured RPC, chat, recovery, state, schedule, workflow, or MCP events need to be collected.
`;

export const durableObjects = `
Official Cloudflare skill: durable-objects
Source: https://github.com/cloudflare/skills/tree/main/skills/durable-objects
Docs: https://developers.cloudflare.com/durable-objects/

Use Durable Objects for:
- Stateful coordination such as chat rooms, multiplayer games, collaborative documents, booking, inventory, and per-tenant/per-user state.
- Strong consistency for a single entity.
- Persistent WebSockets and real-time connection coordination.
- Scheduled per-entity work via alarms.

Avoid Durable Objects for:
- Stateless request handling.
- Work that can be split into independent globally distributed requests.

Implementation notes:
- Add a durable_objects binding and a migrations entry in wrangler.jsonc.
- Prefer SQLite-backed Durable Objects with new_sqlite_classes for new classes.
- Export Durable Object classes from the Worker entrypoint.
- Access DOs through an env binding with idFromName/getByName or idFromString/get.
- Use ctx.blockConcurrencyWhile for initialization that must complete before other events run.
- Use ctx.storage.sql for structured per-object data when SQL fits the domain.
- Generate binding types after config changes.
`;

export const workersBestPractices = `
Official Cloudflare skill: workers-best-practices
Source: https://github.com/cloudflare/skills/tree/main/skills/workers-best-practices
Docs: https://developers.cloudflare.com/workers/best-practices/workers-best-practices/

Load before writing or reviewing Workers code, wrangler.jsonc, bindings, secrets, streaming, observability, or Worker architecture.

Rules quick reference:
- Set a recent compatibility_date for new projects and update periodically on existing projects.
- Enable nodejs_compat when libraries need Node.js built-ins.
- Generate Env types with wrangler types; do not hand-write binding interfaces.
- Use wrangler secret put for secrets; never hardcode secrets in source or config.
- Prefer wrangler.jsonc over TOML for modern Workers features.
- Stream large or unknown payloads instead of buffering them with response.text().
- Use ctx.waitUntil() for post-response work; avoid floating promises.
- Prefer bindings over Cloudflare REST API calls from Workers.
- Use Queues or Workflows for background work.
- Use service bindings for Worker-to-Worker calls rather than public HTTP.
- Use Hyperdrive for external PostgreSQL/MySQL connections.
- Enable Workers observability for production.
`;

export const wrangler = `
Official Cloudflare skill: wrangler
Source: https://github.com/cloudflare/skills/tree/main/skills/wrangler
Docs: https://developers.cloudflare.com/workers/wrangler/

Load before changing wrangler.jsonc, adding bindings, running deploy/dev/typegen commands, or configuring KV, R2, D1, Vectorize, Hyperdrive, Workers AI, Containers, Queues, Workflows, Pipelines, or Secrets Store.

Guidelines:
- Prefer Wrangler over hand-rolled Cloudflare API requests.
- Prefer wrangler.jsonc. Newer features are often JSON-only.
- Include "$schema": "./node_modules/wrangler/config-schema.json" where useful.
- Use a recent compatibility_date and add required compatibility_flags explicitly.
- Generate TypeScript bindings with wrangler types after config changes.
- Local dev uses local simulated bindings unless remote: true is configured.
- Use environments for staging/production when the app has separate deploy targets.
- Use wrangler deploy --dry-run for validation when production deploy is not intended.
- Use wrangler tail for live logs and wrangler check startup to inspect Worker startup cost.
`;

export const cloudflareEmailService = `
Official Cloudflare skill: cloudflare-email-service
Source: https://github.com/cloudflare/skills/tree/main/skills/cloudflare-email-service
Docs: https://developers.cloudflare.com/email-service/

Use when building email sending, email routing, transactional email, Agents SDK email handling, deliverability, SPF/DKIM/DMARC, or wrangler email setup.

Implementation notes:
- Prefer Cloudflare Email Service bindings for Workers when sending from a Worker.
- For receiving email, use Email Routing and an email() handler.
- For Agents SDK email flows, use the Agent email hooks and reply helpers documented by Cloudflare.
- Verify the domain is enabled for email sending before writing app code.
- Add send_email binding configuration to wrangler.jsonc for Workers sending.
- Install postal-mime only when parsing inbound email.
- Treat email product details as fast-moving; verify current docs and workers-types for binding shapes.
`;

export const cloudflareSandboxSdk = `
Official Cloudflare skill: sandbox-sdk
Source: https://github.com/cloudflare/skills/tree/main/skills/sandbox-sdk
Docs: https://developers.cloudflare.com/sandbox/

Use when building secure code execution, AI code interpreters, CI/CD systems, interactive dev environments, or any feature executing untrusted code.

Implementation notes:
- Install @cloudflare/sandbox only when the app needs isolated code execution.
- The Worker must re-export Sandbox from @cloudflare/sandbox.
- Configure containers, Durable Object binding, and a new_sqlite_classes migration in wrangler.jsonc.
- Use getSandbox(env.Sandbox, instanceName) to get an isolated sandbox.
- Use sandbox.exec() for shell commands and sandbox.runCode() for interpreter-style AI code execution.
- Use explicit code contexts for production so state is scoped intentionally.
- Local development requires Docker.
`;

export const cloudflareTurnstile = `
Official Cloudflare skill: turnstile-spin
Source: https://github.com/cloudflare/skills/tree/main/skills/turnstile-spin
Docs: https://developers.cloudflare.com/turnstile/

Use when adding Turnstile, CAPTCHA, bot protection, siteverify, cf-turnstile-response, or protecting signup/login/contact forms.

Implementation notes:
- Add the Turnstile widget to the target form and submit the token with the form data.
- Verify tokens server-side with Cloudflare siteverify before accepting protected actions.
- Keep the secret key server-side only.
- Store production secrets with Wrangler secrets or Cloudflare dashboard secrets, not local source files.
- For a Worker-backed app, validation belongs in the Worker route or server function that handles the protected action.
- Ask for or infer the production hostname before assuming widget domain configuration.
`;

export const webPerf = `
Official Cloudflare skill: web-perf
Source: https://github.com/cloudflare/skills/tree/main/skills/web-perf

Use when auditing, profiling, debugging, or optimizing page load performance, Core Web Vitals, Lighthouse scores, render-blocking resources, network chains, caching, layout shifts, or accessibility gaps.

Ghostbuild practical guidance:
- Optimize visible real user experience first: LCP, INP, CLS, FCP, TBT, and Speed Index.
- Verify an issue before recommending removal or lazy loading.
- Be specific: identify exact assets, routes, scripts, images, and CSS causing cost.
- Prioritize fixes with measurable impact over generic "optimize everything" advice.
- Keep hero media appropriately sized and avoid layout shifts by reserving dimensions.
- Minimize render-blocking CSS and unnecessary client JavaScript.
- Use accessible semantic markup, labels, focus states, and adequate contrast while improving performance.
`;
