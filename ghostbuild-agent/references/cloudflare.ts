export const cloudflarePlatform = `
Official Cloudflare skill: cloudflare
Source: https://github.com/cloudflare/skills/tree/main/skills/cloudflare

Use for any Cloudflare development task. The official skill covers Workers, Pages, KV, D1, R2, Workers AI, Vectorize, Agents SDK, networking, security, and infrastructure-as-code.

Retrieval-first rule:
- Cloudflare APIs, limits, pricing, config fields, compatibility dates, and type signatures change. Prefer current Cloudflare docs, local node_modules types, and wrangler schema over pre-trained memory.
- When docs and local snippets disagree, trust the current docs.

Ghostbuild managed deployment boundary:
- Production provisioning, publishing, and readback attestation support Workers AI as AI, D1 as DB, R2 as APP_STORAGE,
  KV as APP_CACHE, and the protected AppAgent plus AGENT_SECURITY_DB.
- Other Cloudflare products may be valid platform choices, but do not claim managed deployment support or add their
  Wrangler bindings. The deployment planner rejects unsupported capabilities instead of silently dropping them.

Decision guide:
- Agent-owned durable background work -> an Agent Fiber. Decide ownership
  before choosing a general background-processing primitive.
- Full browser application with routes, SSR, and server functions -> TanStack Start on Workers by default when the user does not specify a framework.
- HTTP API, webhook, middleware, or small custom edge script -> a direct Worker handler without an application framework.
- Scheduled task -> a Worker scheduled handler with Cron Triggers.
- Non-Agent asynchronous event processing -> a Queue consumer or Workflow, depending on whether the work is message-driven or a durable multi-step job.
- Lightweight response rewriting at the edge -> Snippets when its product limits fit; otherwise a Worker.
- Relational data -> D1, or Hyperdrive for an existing external SQL database.
- Object/file storage -> R2.
- Key/value config, low-write settings, or sessions -> KV.
- Non-Agent async processing -> Queues or Workflows.
- Vector search -> Vectorize.
- Stateful coordination, per-room/per-user state, WebSockets, or strong consistency -> Durable Objects or Agents SDK.
- LLM inference -> Workers AI binding when available.
- App-level AI agent behavior -> Agents SDK and AIChatAgent.
- Do not provision a product or introduce a framework merely because it exists in the starter template.
`;

export const cloudflareWeekly = `
Cloudflare weekly review:
- No owner-approved weekly guidance update is currently published.
- Continue using the bundled Cloudflare guidance and verify fast-moving APIs against current official documentation.
`;

export const cloudflareStorage = `
Cloudflare storage:
- Use D1 for relational data.
- Use R2 for object and file storage.
- Use KV for simple low-write key/value data.
- Use an Agent Fiber for async work owned by an Agent.
- Use Queues for application-owned, message-driven async jobs.
- Use Vectorize for vector search.
- In generated TanStack routes and server functions, call getAppBindings() from "@/app-bindings" for application DB/R2/KV access.
- Do not import "cloudflare:workers" in generated source. AI, AppAgent, and AGENT_SECURITY_DB bindings are intentionally
  unavailable to generated routes.
- Ghostbuild managed production provisions DB, APP_STORAGE, and APP_CACHE. Queues, Vectorize, Hyperdrive, Workflows,
  and other resource bindings require a future end-to-end capability addition.
`;

export const workersAi = `
Workers AI:
- The AppAgent template already owns the AI binding and inference boundary.
- Do not access env.AI or import "cloudflare:workers" from generated routes or server functions.
- Use @cf/zai-org/glm-5.2 for coding-agent and app AI features through the reviewed AppAgent.
- For chat UI, prefer the template AIChatAgent plus useAgentChat from @cloudflare/ai-chat/react instead of custom /api/ai routes.
`;

export const cloudflareAgentsSdk = `
Official Cloudflare skill: agents-sdk
Source: https://github.com/cloudflare/skills/tree/main/skills/agents-sdk
Docs: https://developers.cloudflare.com/agents/

Use when creating stateful AI agents, durable workflows, WebSocket apps, scheduled tasks, MCP servers, chat applications, voice agents, browser automation, or any feature using the Agents SDK.

Ghostbuild defaults:
- Use the agents package for durable agent identities and callable methods.
- Use an Agent Fiber for durable background work whose state and lifecycle
  belong to one Agent. Use a Workflow only when the work belongs to the
  application or another owner outside that Agent.
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

export const cloudflareAgentHarnesses = `
Cloudflare agent harness libraries:
Docs: https://developers.cloudflare.com/agents/harnesses/think/
Voice: https://developers.cloudflare.com/agents/communication-channels/voice/
Code Mode: https://developers.cloudflare.com/agents/tools/codemode/

Use current official docs and installed package types for these fast-moving packages:
- @cloudflare/think provides a stateful agentic chat loop, durable messages, streaming, tools, sub-agent RPC, and a
  SQLite-backed workspace. Keep AI SDK majors aligned: ai v7 pairs with @ai-sdk/react v4.
- @cloudflare/shell supplies the Think workspace and bounded shell-style file tools. Treat model-produced scripts and
  their outputs as untrusted; keep file, byte, time, and network limits explicit.
- @cloudflare/voice provides withVoice/withVoiceInput plus React and framework-neutral clients for WebSocket voice,
  transcription, synthesis, persistence, and interruption handling. Voice is beta; require microphone permission and
  never expose provider credentials to the browser.
- @cloudflare/codemode composes tools through generated code. Prefer direct tools for small fixed catalogs; use Code
  Mode for dependent calls, discovery, loops, filtering, and branching. It is experimental, so pin and verify its API.
- The browser-safe Code Mode export uses an isolated iframe. Worker-side Code Mode commonly needs a Worker Loader
  binding, which Ghostbuild managed deployment does not currently provision.
- Think and Voice replace or extend the protected AppAgent server implementation. Do not modify that boundary from a
  generated app; explain that managed production support is not available yet rather than claiming deployment works.
`;

export const cloudflareRealtime = `
Cloudflare RealtimeKit:
Docs: https://developers.cloudflare.com/realtime/realtimekit/

Use RealtimeKit for embedded live audio/video meetings, webinars, or calls. Prefer @cloudflare/realtimekit-react for a
React app, @cloudflare/realtimekit for the framework-neutral web client, and the UI kit when prebuilt meeting controls
fit. Initialize clients only with a short-lived participant auth token returned by a trusted backend. Never embed the
Realtime API token or create participant credentials in browser code. Ghostbuild managed deployment does not provision
RealtimeKit apps or secret-backed meeting APIs today; use an existing trusted token service or report the boundary.
`;

export const cloudflareFlagship = `
Cloudflare Flagship:
Docs: https://developers.cloudflare.com/flagship/get-started/

Use Flagship for remotely managed feature flags and targeting. In a normal Worker, prefer the Flagship binding and run
wrangler types; @cloudflare/flagship/server integrates the binding with OpenFeature, while the SDK can also run outside
Workers. Always provide a safe application default when evaluation fails and keep targeting context free of unnecessary
personal data. Ghostbuild managed deployment does not yet provision or attest Flagship bindings, so do not add a
flagship entry to a generated wrangler.jsonc until that capability is supported end to end.
`;

export const cloudflareWorkersTesting = `
Cloudflare Workers testing:
Docs: https://developers.cloudflare.com/workers/testing/vitest-integration/

Use @cloudflare/vitest-pool-workers for Worker-runtime unit and integration tests that need real Workers APIs or local
bindings. Current releases use cloudflareTest() as a Vite plugin and require Vitest 4.1 or later. Point it at the existing
wrangler.jsonc, keep test storage isolation by default, and use cloudflare:test helpers for bindings and execution
contexts. Remember the pool injects nodejs_compat for tests; production code that needs Node built-ins must still declare
nodejs_compat in wrangler.jsonc. Use instrumented coverage because native V8 coverage is not supported.
`;

export const cloudflareComputer = `
Cloudflare Computer library:
Source: https://github.com/cloudflare/cloudflare-computer

@cloudflare/computer provides a durable workspace and execution facade over a Cloudflare Container. Ghostbuild already
owns Computer synchronization, retries, filesystem durability, command disposal, and the computerd lifecycle inside the
user workspace runtime. Generated applications must not import Computer, access PROJECT_WORKSPACE, or create a second
workspace synchronization path. Use the normal Ghostbuild file/edit/exec tools; changes to Computer belong in the
reviewed workspace runtime and require package-type and failure-recovery verification.
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
- Outside Ghostbuild, set a recent compatibility_date for new projects and update periodically on existing projects.
- In Ghostbuild, preserve the exact compatibility_date already present in the project template. Automatic deployment
  pins it to a centrally tested value.
- Enable nodejs_compat when libraries need Node.js built-ins.
- Generate Env types with wrangler types; do not hand-write binding interfaces.
- Use wrangler secret put for secrets; never hardcode secrets in source or config.
- Prefer wrangler.jsonc over TOML for modern Workers features.
- Stream large or unknown payloads instead of buffering them with response.text().
- Use ctx.waitUntil() for post-response work; avoid floating promises.
- Prefer bindings over Cloudflare REST API calls from Workers.
- Use Agent Fibers for work owned by an Agent; use Queues or Workflows for
  application-owned background work.
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
- Outside Ghostbuild, use a recent compatibility_date. In Ghostbuild, never change the template's existing
  compatibility_date because automatic deployment pins it to a centrally tested value.
- Add required compatibility_flags explicitly.
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
- Ghostbuild managed deployment does not provision send_email today; do not add it to a generated project or claim the
  app is production-deployable through Ghostbuild until that capability is implemented.
- Install postal-mime only when parsing inbound email.
- Treat email product details as fast-moving; verify current docs and workers-types for binding shapes.
`;

export const cloudflareSandboxNext = `
Official Cloudflare skill: sandbox-next
Source: https://github.com/cloudflare/skills/tree/main/skills/sandbox-next
Migration skill: https://github.com/cloudflare/skills/tree/main/skills/sandbox-migrate-to-next
Docs: https://developers.cloudflare.com/sandbox/1-0-preview/

Use when building secure code execution, AI code interpreters, CI/CD systems, interactive dev environments, or any feature executing untrusted code.

Implementation notes:
- Use @cloudflare/sandbox@next for new Sandbox applications and a matching @next container image. Never mix stable and
  preview protocol lines.
- The Worker must re-export Sandbox from @cloudflare/sandbox.
- Configure containers, Durable Object binding, and a new_sqlite_classes migration in wrangler.jsonc.
- Use getSandbox(env.Sandbox, instanceName) to get an isolated sandbox.
- sandbox.exec() accepts argv and returns after launch. Read completion from process.output(), waitForExit(), or logs().
- There is no implicit shell: use ["/bin/bash", "-lc", script] only when shell syntax is required.
- Observation timeouts cancel the wait, not the remote process. Set the exec timeout and explicitly kill on an
  observation failure. Signals are numeric.
- Persist the SDK-issued process id when later requests must recover a live process, but treat it as runtime-local and
  persist the full job definition when work must survive container replacement.
- Use createTerminal() for interactive input; process handles have no stdin.
- Local development requires Docker.
- Stable-to-@next production cutovers require one immediate 100% container rollout because the protocols are mutually
  incompatible. In-flight work can stop during the cutover.
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
- Reject missing, malformed, or oversized tokens before the network call; apply a short timeout and fail closed when
  siteverify is unavailable or returns success=false.
- Validate the returned hostname and, when supplied by the protected flow, the expected action. Do not trust only the
  success boolean.
- Turnstile tokens expire and are single-use. Reset or rerender the widget after submission so retries receive a fresh
  token and replayed submissions do not bypass application idempotency.
- Never ask the user to paste the Turnstile secret into chat. Ask only for the binding name and production hostname.
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
