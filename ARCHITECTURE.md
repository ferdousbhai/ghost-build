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

| State                                                   | Owner                 |
| ------------------------------------------------------- | --------------------- |
| Conversation turns and compaction                       | Durable Object SQLite |
| Chats, shares, deployment records, quota, and auth      | D1                    |
| Backup bytes, compressed history, snapshots, and images | R2                    |
| Current generated project and processes                 | Browser WebContainer  |

Do not create a second authoritative store for the same state. Materialized copies must be rebuildable or explicitly
reconciled with their owner.

Chat-backup admission is tenant-wide and atomic in D1. The quota model separates pending admissions, physical R2
objects, and per-owner object attributions so shared or cloned objects are charged to every tenant that can retain
them without duplicating physical bytes. The scheduled reconciliation pass repairs the materialized object ledger from
authoritative D1 references and bounded R2 metadata reads.

## Generated-Application Boundary

`template/` is an independent application with its own Worker, Agent, migrations, dependencies, and Wrangler
configuration. Generated applications keep user application data in `DB` and Agent sessions, retention state, and
inference accounting in the separately provisioned `AGENT_SECURITY_DB`. Only the AppAgent runtime may import the
security binding; the protected build policy checks the resolved module graph so aliases and dependencies cannot widen
that capability boundary.

Root dependencies do not implicitly apply to the template. A template change is complete only when its snapshot and
manifest have been regenerated and standalone verification passes.

## Trust Boundaries

User input, generated code, feedback, model output, and repository context are untrusted. Secrets remain in server-side
Cloudflare bindings; generated-project actions reject secret files. Deployment uses an immutable source snapshot,
server-derived resource plan, explicit user approval, and a revision-bound validation receipt. Managed Worker intent is
recorded before publishing, and the deployed version, script etag, bindings, variables, and schedules must attest to the
server-owned security baseline. Periodic inventory detects drift and preserves ambiguous publish outcomes for owner
review instead of silently losing them.
