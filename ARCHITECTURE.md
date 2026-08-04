# Architecture

This file records boundaries that are difficult to infer from one module. Use [AGENTS.md](AGENTS.md) to locate the
implementations.

## Dependency Direction

```text
route or view
  -> controller or orchestration service
    -> domain policy or model
      -> repository or platform adapter
```

Views render state and forward events. Orchestrators coordinate use cases. Domain policies remain independent of React
and platform bindings. Repositories and adapters own D1, R2, Durable Object, Workers AI, Sandbox, and HTTP details.
Lower layers receive narrow capabilities instead of importing application-wide stores.

## Account Boundary

Ghostbuild is a control plane, not the host for customer projects. Its Worker and D1 retain identity, encrypted
Cloudflare authorization, authentication state, connection metadata, runtime locators, and privacy-filtered operational
events. The root deployment has no R2 bucket, Container, application Durable Object, or Workflow binding.

Connecting Cloudflare provisions a workspace Worker, D1 database, `BuilderAgent` Durable Objects, and a
`ProjectWorkspace` Durable Object backed by a Cloudflare Container in that user's account. The browser receives a
short-lived, origin-bound capability and communicates directly with that Worker for chat, project, preview, and
deployment operations. Generated-application D1 and R2 resources are created later only when the validated deployment
plan requires them. Cloudflare meters those resources to the user's account.

## State Ownership

| State                                                                                             | Authoritative owner                                  |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Identity, OAuth credentials, sessions, connection metadata, runtime locators                      | Ghostbuild control-plane D1                          |
| Chat catalog, transcript identity, deployment plans and resources, Agent garbage-collection queue | User workspace D1                                    |
| Agent messages, turn state, compaction, and resumable execution                                   | User-owned `BuilderAgent` DO SQLite                  |
| Project bytes, numeric revision, change index, tool journal, and validation receipts              | User-owned `ProjectWorkspace` Computer VFS/DO SQLite |
| Dependency installation, validation, preview, and deployment processes                            | User-owned `ProjectWorkspace` Container backend      |
| Collection replicas and editor files                                                              | Rebuildable browser SQLite/cache                     |
| Generated application's Worker, D1, R2, Agent, and related resources                              | User's Cloudflare account                            |

Do not create a second authoritative store for the same state. Browser and process-local materializations must be
rebuildable from their owner. Cloudflare Computer's SQLite VFS in `ProjectWorkspace` is the sole authority for project
files; the browser editor and container mount are replicas of that state.

## Transcript Reconciliation

`BuilderAgent` DO SQLite is the only authoritative message transcript. Generation, reload, interrupted-turn recovery,
and context compaction all read that transcript. User workspace D1 stores only the chat catalog and the active
transcript identity: Agent name, generation, subchat index, monotonic head revision, message count, and SHA-256 digest.
The browser's TanStack collection is a rebuildable reload cache. There is no separate sharing transcript, server-side
rewind snapshot, R2 message backup, or WebContainer snapshot in the current architecture.

Reconciliation is deterministic:

1. Reload resolves the owner-scoped transcript identity from D1 and reads messages from that exact `BuilderAgent`. A
   mismatched Agent identity or generation is a conflict, never a fallback to another history.
2. Before send, the browser asks the Agent for its current checkpoint and hashes its local messages. A mismatch blocks
   the send and requires a reload. The checkpoint is also attached as transient base metadata, so an Agent rejects a
   stale client that races after the preflight.
3. Catalog checkpointing re-reads the Agent and accepts only an exact checkpoint. D1 updates require the same identity,
   never decrease revision or message/part position, and require an equal digest at an equal revision. A stale write
   receives `409` with the durable checkpoint and cannot overwrite newer history.
4. A browser may adopt that returned checkpoint only when it has the same identity and its complete local messages hash
   to the returned digest. Divergent local messages are not merged or uploaded; reload restores the Agent transcript.
5. A subchat records its parent subchat, parent generation, and parent revision. Creation conditionally advances the
   active pointer and uses a unique transition token to recognize an exact commit whose acknowledgement was lost.

The open issue that introduced this contract referred to R2 transcript objects, browser-produced compressed history,
WebContainer snapshots, and preserving legacy rewind behavior. Those storage planes were retired by the intentional
breaking rebuild. The applicable invariant is therefore readability and recovery of current DO transcripts; importing
or reconciling the retired R2/WebContainer formats is explicitly not a compatibility requirement.

## Project Lifecycle

`BuilderAgent` owns conversation execution and delegates project operations to `ProjectWorkspace`. Cloudflare Computer
stores files directly in the Durable Object's SQLite VFS. Its worker-shell backend operates against that authoritative
store over Workers RPC; its container backend projects the same files into the Container through FUSE and reconciles
changes back to the VFS. There is no application-level ZIP archive, R2 backup, or duplicate project blob in the control
plane.

The model's `read`, `write`, `edit`, `ls`, and `exec` tools come from `@cloudflare/computer/tools`; Ghostbuild adds only
durable replay, mutation ordering, and product-specific operations around them. Model tools and editor reads use the
same workspace API. Browser saves use compare-and-swap against the numeric revision the browser loaded; a conflict
refreshes from the user runtime and never overwrites newer state. TanStack DB collections combine the server query
collection with a per-account browser SQLite persistence layer. That local data is a performance and offline-start
replica, not an authority.

Dependency installation runs through Computer's container backend and persists the reviewed manifest and lockfile back
to the VFS. Validation, preview, and deployment operate on content checkpoints from that same workspace. Validation
receipts bind to a content digest, so deployment cannot proceed after the project changes.

## Preview Boundary

The `ProjectWorkspace` container backend builds the dedicated Vite preview for the current content checkpoint, starts
the preview process, and exposes it through a Cloudflare quick tunnel. The user workspace Worker returns the tunnel URL
to the authenticated browser and schedules expiry after 15 minutes. Stopping, expiry, or replacement destroys the
preview process and tunnel.

Preview work and bandwidth remain in the user's Cloudflare account. OAuth credentials and control-plane secrets are
not passed to generated project processes.

## Deployment Boundary

Deployment planning and approval are recorded in the user workspace D1. Execution verifies that Computer's current
content checkpoint still matches the validated revision, repeats the production checks through the container backend,
provisions the requested resources through the user's Cloudflare API authorization, applies migrations, and publishes
with Wrangler. Ghostbuild stores no deployment archive.

The deployment executor derives resource names and security-sensitive configuration on the server. It records managed
Worker intent before publishing, then reads back the deployed version, script etag, bindings, variables, and schedules.
Ambiguous publish outcomes remain visible for owner review rather than being silently discarded.

The workspace Worker never stores the user's OAuth access token as a binding. At deployment time it exchanges its
derived, generation-specific runtime secret at the control plane for a freshly resolved token. The broker rechecks the
active user, connection, generation, and credential handle; returns `Cache-Control: no-store`; and never follows an
alternate origin. Production pins that broker to `https://ghostbuild.dev` in
`user-workspace-runtime-policy.ts`. An open-source fork must change that constant to its own HTTPS control-plane origin,
regenerate the user runtime, and re-provision existing user runtimes. Redirecting the configured endpoint is
intentionally unsupported because it would disclose the runtime secret.

## Generated-Application Boundary

`template/` is an independent application with its own Worker, Agent, migrations, dependencies, and Wrangler
configuration. Generated applications keep user application data in `DB` and Agent sessions, retention state, and
inference accounting in the separately provisioned `AGENT_SECURITY_DB`. Only the AppAgent runtime may import the
security binding; the protected build policy checks the resolved module graph so aliases and dependencies cannot widen
that capability boundary.

Root dependencies do not implicitly apply to the template. A template change is complete only when the bundled
Builder workspace module has been regenerated and standalone verification passes.
Generated-project package-manager constraints live in
`template/scripts/lib/project-policy/generated-project-dependency-policy.json`; browser admission and repository/template
verification consume that same data rather than maintaining separate security override lists.

## Cloudflare Computer Dependency

Ghostbuild intentionally pins `@cloudflare/computer` to `0.1.1`. Cloudflare labels this release preview-only, describes
its API as unstable, and says it is not suitable for production use. The repository therefore treats every upgrade as
an architecture review: tests pin the installed version, tool names, complete AI SDK input schemas, result fields used by
the build lifecycle, read-only behavior, backend selectors, and backend capability descriptions. Tool configuration
explicitly disables Computer's optional `publish` capability and pins the reviewed default limits: 2,000 lines or 256
KiB per read, 2 MiB per write/edit, and 64 KiB for each exec output stream. These gates detect drift; they cannot turn a
preview dependency into a stable production contract. AI SDK cancellation is checked before a queued tool starts, but
Computer 0.1.1's published tool executors neither consume nor forward `ToolExecutionOptions.abortSignal`; an operation
already in flight therefore relies on the workspace runtime's bounded timeout instead of client cancellation.

## Model Context and Prefix Caching

The browser sends open, recently used, and locally modified file context as a bounded turn attachment. The server adds
that attachment only to the current model view; it never persists the generated context as a transcript message. After
compaction, the model reacquires authoritative facts on demand through Computer's paged `read` tool and bounded
worker-shell `exec` searches. Retrieved source remains untrusted project data.

Workers AI prefix caching is automatic for supported models. Ghostbuild sends an opaque, stable session-affinity value
per transcript generation, keeps system instructions at the front of the prompt, and leaves dynamic project context in
the latest user turn. Cache availability never changes the model-visible input or correctness path. Finish telemetry
reads AI SDK `totalUsage.inputTokenDetails.cacheReadTokens`, distinguishes hit, miss, and unavailable states, and logs a
privacy-safe model-input fingerprint without logging prompt contents. Small historical samples observed lower affinity
latency but reported zero cached tokens, so Ghostbuild claims no verified cached-token cost savings. The retained
decision record is `scripts/evaluations/DECISIONS.md`.

## Trust Boundaries

User input, generated code, model output, and repository context are untrusted. Secrets remain in server-side
Cloudflare bindings; generated-project actions reject secret files. Generated code never executes in the Ghostbuild
control-plane Worker. Runtime capabilities are short-lived and bound to the authenticated user and browser origin.
