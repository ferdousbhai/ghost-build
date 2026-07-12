# Ghostbuild

Repository index for agents.

## Start Here

- [README.md](README.md) — product, runtime, deployment, and repository overview
- [ARCHITECTURE.md](ARCHITECTURE.md) — module boundaries, dependency direction, and agent context flow
- [DEVELOPMENT.md](DEVELOPMENT.md) — local setup, verification, deployment, and template workflow
- [package.json](package.json) — canonical root build, validation, and deployment pipelines

## Execution Surfaces

- [app/server.ts](app/server.ts) is the deployed root Worker application: product routes, data APIs, authentication, and the `BuilderAgent` runtime.
- [app/lib/webcontainer/](app/lib/webcontainer/) and [app/lib/stores/startup/](app/lib/stores/startup/) boot the browser WebContainer, where the current generated project, package commands, previews, and tool actions run.
- [template/](template/) is the source of newly generated applications. Its Worker, Agent, dependencies, migrations, and deployment config are independent from the root application.

## Runtime And Agent

- [app/server.ts](app/server.ts) — Worker entrypoint and HTTP dispatch; Agent requests are routed before auth, data APIs, and TanStack Start
- [app/agents/builder-agent.ts](app/agents/builder-agent.ts) — `BuilderAgent` Durable Object lifecycle, recovery, and context preparation
- [app/agents/builder-turn-store.ts](app/agents/builder-turn-store.ts) — persisted turn status and history
- [app/lib/.server/chat.ts](app/lib/.server/chat.ts) — server-side model and tool orchestration
- [app/lib/.server/llm/](app/lib/.server/llm/) — context compaction, input budgeting, memory, Workers AI adapters, and turn-local context
- [ghostbuild-agent/](ghostbuild-agent/) — shared protocol types, prompts, parsing, workspace-context selection, and tool definitions consumed by the browser and root Worker; the runtime loop itself lives in `app/agents/` and `app/lib/.server/`
- [wrangler.jsonc](wrangler.jsonc) — production Worker bindings and Durable Object migration

## App Surfaces

- [app/routes/](app/routes/) — TanStack file routes
- [app/components/chat/Chat.tsx](app/components/chat/Chat.tsx) — chat composition; controller hooks live beside it
- [app/lib/stores/workbench.client.ts](app/lib/stores/workbench.client.ts) — workbench facade over files, editor, previews, terminals, and artifact execution
- [app/lib/runtime/action-runner.ts](app/lib/runtime/action-runner.ts) — generated-project action dispatcher; implementations live in `app/lib/runtime/action-runner/`
- [app/lib/stores/startup/](app/lib/stores/startup/) — WebContainer bootstrap, history restoration, and backup synchronization
- [app/components/editor/codemirror/](app/components/editor/codemirror/) — editor view, configuration, and document synchronization

## Persistence And APIs

- [app/lib/cloudflare/data.server.ts](app/lib/cloudflare/data.server.ts) — authenticated data-operation and upload HTTP facade
- [app/lib/cloudflare/data/](app/lib/cloudflare/data/) — D1 repositories/services, R2 object storage, ownership checks, and garbage collection
- [app/lib/cloudflare/data-api.ts](app/lib/cloudflare/data-api.ts) — typed browser/server operation contract
- [app/lib/cloudflare/data-operation-schemas.ts](app/lib/cloudflare/data-operation-schemas.ts) — request validation for that contract
- [migrations/](migrations/) — root application's D1 schema history

## Generated-App Template

- [template/](template/) — source project copied into every new generated app; it is an independent workspace with its own runtime and deployment config
- [template/src/server.ts](template/src/server.ts) — generated app Worker entrypoint
- [template/src/agents/app-agent.ts](template/src/agents/app-agent.ts) — generated app Agent
- [template/scripts/lib/project-policy.mjs](template/scripts/lib/project-policy.mjs) — generated-project stack and configuration policy
- [make-bootstrap-snapshot.js](make-bootstrap-snapshot.js) — builds the compressed template artifact and manifest
- [scripts/template-source.mjs](scripts/template-source.mjs) — computes the template source identity used to detect stale snapshots
- [scripts/verify-template.mjs](scripts/verify-template.mjs) — validates a clean copy of the template as a standalone project
- Changes to `template/` require a matching regenerated snapshot and manifest from [make-bootstrap-snapshot.js](make-bootstrap-snapshot.js); [scripts/verify-stack-alignment.mjs](scripts/verify-stack-alignment.mjs) detects stale artifacts.

## Embedded And Generated Artifacts

- [proxy/proxy.cjs](proxy/proxy.cjs) and [iframe-worker/worker.mts](iframe-worker/worker.mts) are sources; their adjacent `*.bundled.*` files are build outputs consumed as raw text by the app
- [public/template-snapshot-manifest.json](public/template-snapshot-manifest.json) identifies the single `public/template-snapshot-*.bin` artifact built from `template/`
- `app/routeTree.gen.ts`, `template/src/routeTree.gen.ts`, root `worker-configuration.d.ts`, and `template/worker-configuration.d.ts` are generated from route or Wrangler config sources
- [scripts/verify-stack-alignment.mjs](scripts/verify-stack-alignment.mjs) enforces root/template dependency alignment, generated-artifact freshness, and forbidden runtime/config patterns

## Critical Boundaries

- D1 owns relational chat/share state; R2 owns snapshots, compressed histories, and thumbnails; `BuilderAgent` Durable Object SQLite owns turn and compaction state.
- Browser turn context is a bounded workspace hint. The durable Agent transcript remains authoritative, and stored repository hints must be revalidated against current files.
- Generated projects must not persist secrets in source or local env files; secret-file and package-manifest guards are enforced in the action path and stack verifier.
