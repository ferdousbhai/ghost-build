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

`BuilderAgent` owns agent execution, the durable conversation, and the turn lifecycle.
`BuilderWorkspaceRepository`, colocated with that Agent in Durable Object SQLite, is the sole authoritative source for
the generated project. Model input and the explicit `view`, `listFiles`, `searchText`, `edit`, and `writeFile` tools
read or mutate that repository directly. Dependency installation, validation, deployment builds, and previews operate
on immutable snapshots of an exact durable workspace revision.

Browsers are presentation clients, never required execution environments. Chat works without browser filesystem,
process, cross-origin-isolation, or container support. The code editor is a rebuildable read-through cache populated
from authenticated BuilderAgent workspace APIs. A manual save is one compare-and-swap operation against the revision
the user loaded; a conflict reloads the durable source and never rebases or overwrites newer server state. Ghostbuild
does not expose a persistent general-purpose terminal.

Model input is assembled once in `app/lib/.server/llm/`. That boundary applies persisted compaction state, current
turn context, tool schemas, pruning, and the provider budget before generation.

## State Ownership

| State                                                                | Owner                                   |
| -------------------------------------------------------------------- | --------------------------------------- |
| Agent execution, conversation turns, and compaction                  | `BuilderAgent` Durable Object           |
| Generated-project source and revision history                        | `BuilderWorkspaceRepository` DO SQLite  |
| Users, chats, preview admission, deployment records, quota, and auth | Ghostbuild D1                           |
| Oversized workspace objects and retained customer artifacts          | Customer `ghostbuild-user-data` R2      |
| Public thumbnails and bounded temporary build artifacts              | Ghostbuild R2                           |
| Dependency, validation, deployment-build, and preview processes      | Short-lived `DeploymentSandbox` objects |
| Editor files and preview display state                               | Rebuildable browser presentation cache  |

Do not create a second authoritative store for the same state. Materialized copies must be rebuildable or explicitly
reconciled with their owner.

Chat-backup admission is tenant-wide and atomic in D1. New object keys encode their Ghostbuild owner and route through
that user's active Cloudflare authorization; legacy keys continue to resolve from Ghostbuild R2. Cloning a customer
object materializes a new copy in the recipient's bucket so the clone does not depend on the source owner's connection.
The quota ledger tracks physical objects and owner attribution, while reconciliation repairs legacy estimates from
authoritative D1 references and bounded metadata reads.

## Remote Preview Boundary

One preview is requested after a completed agent turn or an explicit refresh. `BuilderAgent` first captures an
immutable ZIP and digest from one durable workspace revision, then queues a durable preview fiber. D1 admission limits
the account-wide live Sandbox population to the configured two instances, limits each owner to two concurrent
resources, and limits each owner to eight build admissions per hour. Capacity retries are bounded.

`DeploymentSandbox` downloads that snapshot from R2, installs the frozen dependency graph with lifecycle scripts
disabled, builds the static preview configuration, and serves it for a 15-minute lease. The Sandbox receives only a
minimal `PATH` and `NODE_ENV`; Cloudflare OAuth tokens, deployment credentials, user secrets, and application bindings
are never placed in the generated-code environment. Its existing network-deny, package-registry allowlist, and
credential-proxy boundaries remain in force.

Preview URLs use a server-derived UUID plus a 256-bit capability scoped in D1 to the owning chat and exact workspace
revision. Every document and asset request revalidates that capability, chat ownership, deletion state, status, and
expiry before RPC proxying to the Sandbox. Generated documents run in an iframe with an opaque origin, a restrictive
CSP, no cookies, no same-origin privilege, and no direct Sandbox address. A changed workspace marks the last successful
preview stale. Failed replacement builds preserve the previous successful preview. Cancellation, supersession,
timeout, project deletion, and scheduled expiry destroy the Sandbox, release admission, and remove temporary R2 input.

## Generated-Application Boundary

`template/` is an independent application with its own Worker, Agent, migrations, dependencies, and Wrangler
configuration. Generated applications keep user application data in `DB` and Agent sessions, retention state, and
inference accounting in the separately provisioned `AGENT_SECURITY_DB`. Only the AppAgent runtime may import the
security binding; the protected build policy checks the resolved module graph so aliases and dependencies cannot widen
that capability boundary.

Root dependencies do not implicitly apply to the template. A template change is complete only when the bundled
Builder workspace module has been regenerated and standalone verification passes.

## Trust Boundaries

User input, generated code, feedback, model output, and repository context are untrusted. Secrets remain in server-side
Cloudflare bindings; generated-project actions reject secret files. Generated code never executes in the root
Ghostbuild Worker. Deployment uses an immutable source snapshot,
server-derived resource plan, explicit user approval, and a revision-bound validation receipt. Managed Worker intent is
recorded before publishing, and the deployed version, script etag, bindings, variables, and schedules must attest to the
server-owned security baseline. Periodic inventory detects drift and preserves ambiguous publish outcomes for owner
review instead of silently losing them.
