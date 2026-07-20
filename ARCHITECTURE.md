# Architecture

This file records only boundaries that are difficult to infer from one module. Use [AGENTS.md](AGENTS.md) to locate the
implementations.

## Dependency Direction

```text
route or view
  -> controller or orchestration service
    -> domain policy or model
      -> repository or platform adapter
```

Views render state and forward events. Orchestrators coordinate use cases. Domain policies should remain independent of
React and platform bindings. Repositories and adapters own D1, R2, Durable Object, Workers AI, and HTTP details. Lower
layers receive narrow capabilities instead of importing application-wide stores.

## Runtime Boundary

The browser owns the editable generated workspace, previews, and terminal processes. `BuilderAgent` owns the durable
conversation and turn lifecycle. Browser workspace context is a bounded hint; server-side code revalidates stored hints
and current files before using them.

Model input is assembled once in `app/lib/.server/llm/`. That boundary applies persisted compaction state, current
turn context, tool schemas, pruning, and the provider budget before generation.

## State Ownership

| State                                       | Owner                 |
| ------------------------------------------- | --------------------- |
| Conversation turns and compaction           | Durable Object SQLite |
| Chats, shares, deployment records, and auth | D1                    |
| Snapshots, compressed history, and images   | R2                    |
| Current generated project and processes     | Browser WebContainer  |

Do not create a second authoritative store for the same state. Materialized copies must be rebuildable or explicitly
reconciled with their owner.

## Generated-Application Boundary

`template/` is an independent application with its own Worker, Agent, migrations, dependencies, and Wrangler
configuration. Root dependencies do not implicitly apply to it. A template change is complete only when its snapshot
and manifest have been regenerated and standalone verification passes.

## Trust Boundaries

User input, generated code, feedback, model output, and repository context are untrusted. Secrets remain in server-side
Cloudflare bindings; generated-project actions reject secret files. Deployment uses an immutable source snapshot,
server-derived resource plan, explicit user approval, and a revision-bound validation receipt.
