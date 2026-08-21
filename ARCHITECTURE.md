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
events. The root deployment has no Container, application Durable Object, or Workflow binding.

It holds exactly one R2 bucket, and only for a build artifact Ghostbuild itself publishes: the OCI blobs of the user
workspace container image. Cloudflare's registry is account-scoped — repository names are `<account_id>/<image>`,
anonymous reads are refused on every path, and there is no shared namespace or server-side copy API — so the image has
to be pushed into each user's own registry by a client, and that client needs somewhere to read the bytes from. No
customer project data enters this bucket, and nothing in it is user-specific.

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
stores files directly in the Durable Object's SQLite VFS. Its container backend projects the same files into the
Container through FUSE and reconciles changes back to the VFS. There is no application-level ZIP archive, R2 backup, or
duplicate project blob in the control plane.

The model receives six workspace primitives, split by what they cost. `read`, `ls`, and `grep` are answered from the
Durable Object's SQLite VFS alone; `write`, `edit`, and `exec` change the project or run in its Container. `write` and
`exec` adapt the reviewed `@cloudflare/computer/tools` contracts; Ghostbuild's `read` returns numbered lines with a
compact tag bound to the full file SHA-256, and `edit` applies non-overlapping line operations only when that exact
snapshot is still current.

Discovery used to go through `exec`, and the cost of that decision was paid on every question about the project's
shape: a container wake or wait, a shell process launch, and a durable filesystem sync barrier, to answer something the
Durable Object holds in SQLite. `ls` enumerates a directory or the tree beneath it and `grep` returns path, 1-based
line, and matching line for a literal pattern, both directly from the VFS — no container, no sync barrier, and never
the exclusive workspace operation lane, so discovery answers before the container is warm and stays available while a
build command holds the lane. Line numbers come from the same splitter `read` and `edit` use, so a search hit names the
line an edit would change. `grep` matches literal single-line text and never compiles the model's pattern into a
regular expression or a shell command: an untrusted pattern must not be able to backtrack the Durable Object into a
stall or inject into the container. Both tools are bounded in the spirit of Computer's reviewed read and exec limits —
`user-workspace-runtime/src/workspace-discovery.ts` names every ceiling and the failure it prevents — and both report
`truncated` so the model narrows the path or the pattern instead of paging blindly. A recursive walk shows
`node_modules` and build output but does not descend into them, unless one of them is the requested path; that is how
the model still reads the framework version the project installed.
Reference guidance is retrieved rather than mirrored. Cloudflare's own documentation is searched live through the
`search_cloudflare_docs` tool, one stateless request to the public `docs.mcp.cloudflare.com` endpoint that returns
ranked excerpts with their source URLs; a full page is read by appending `/index.md` to any documentation URL.
Framework references are read from the packages the project itself installed, so they always match the version it
builds against. The one skill Ghostbuild maintains ships in this repository and is bundled into the Worker, exposed
through the existing `read` tool under `/__skills__/<skill>/`; no activation or separate resource-reader tool is
added. That namespace is a read-only control-plane overlay: it never enters the project VFS, revision, or deployment
artifact, project files cannot shadow it, and it never appears in `ls` or `grep`, which are asked only about the
project. The evergreen system prompt establishes only authority, safety, and
workflow precedence; concrete product and API guidance comes from retrieval, while code and deployment boundaries
remain enforced by project validation. A documentation search that fails returns a failed tool result the model can
act on, rather than ending the turn.

Model tools and editor reads use the same workspace API. Browser saves use
compare-and-swap against the numeric revision the browser loaded; a conflict refreshes from the user runtime and never
overwrites newer state. TanStack DB collections combine the server query collection with a per-account browser SQLite
persistence layer. That local data is a performance and offline-start replica, not an authority.

Tool-call arguments stream to the browser as the model produces them. `exec` additionally streams bounded transient
stdout/stderr updates while retaining only a bounded final tail for the model; completion still waits for the Container's
filesystem pull to become durable. The Pi loop enforces a total turn limit, model-stream inactivity limit, and per-tool
limits; there is no model-step ceiling. A cancellation requested before a Container process handle exists is retained and applied
as soon as that handle becomes available. Approved `pnpm add <packages>` and `pnpm install --lockfile-only` commands route to
the reviewed dependency installer rather than an unrestricted package-manager shell. After related mutations are complete,
the model requests one full validation and receives its revision-bound receipt. Production deployment
is not a model capability: after validation, `BuilderAgent` admits a durable deployment fiber that runs one authenticated,
idempotent server operation, verifies the current receipt, prepares the exact-revision plan, and executes it in the user's
account. The browser can request a retry but is not responsible for starting deployment. Preview and deployment use
checkpoints from the same VFS, so deployment cannot proceed after the project changes.

## Preview Boundary

A preview has one of two modes, and they carry different guarantees.

A **production** preview is checkpoint-bound. The `ProjectWorkspace` container backend copies the project into an
isolated root, installs dependencies, applies the isolated local D1 schema, builds the dedicated Vite preview for one
exact content checkpoint, starts `vite preview` on that output, and exposes it through a Cloudflare quick tunnel. The
content revision is asserted on entry, after the build, and again before publication, so the reviewed bytes are the
bytes deployment would publish.

A **dev** preview is not bound to any revision; it tracks live workspace state. It prepares the same isolated root and
installs dependencies once, applies the same local D1 schema, and then runs `vite dev`. It performs no production
build, asserts no checkpoint, is never evidence that a revision builds, and satisfies nothing deployment depends on —
deployment reads validation receipts and the current checkpoint, never a preview. The distinction is a discriminant on
`BuilderPreviewSuccess`: only the production shape carries a `snapshotRevision`.

The dev server runs from a container-local root rather than `/home/project`, because `/home` is Computer's projection
of the durable VFS and a dependency tree installed there would be reconciled into DO SQLite. Computer's container sync
is a change-log push into a container-side store served over FUSE, with no notify channel, so a durable write raises no
inotify event inside the container and a watcher pointed at `/home/project` would never fire. Instead, each committed
change set from `applyChanges` — the single path used by both the model's `write`/`edit` tools and browser editor saves
— is written into the dev root as a real container write, which is what Vite's watcher observes. Delivery is
best-effort: a preview that cannot be refreshed never fails a durable mutation that already committed. A dependency
manifest change is not absorbed by a running dev preview, which installs once by design.

Both modes share one lifecycle: one active preview row, one pending-preview cleanup path, one expiry alarm at
`PREVIEW_TTL_MS`, one cancellation table, and one container keep-alive. Requesting either mode replaces the other. The
user workspace Worker returns the tunnel URL to the authenticated browser. Stopping, expiry, replacement, or the start
of a deployment session destroys the preview process and tunnel regardless of mode.

Preview work and bandwidth remain in the user's Cloudflare account. OAuth credentials and control-plane secrets are
not passed to generated project processes.

## Deployment Boundary

Deployment state and resource intent are recorded in the user workspace D1. Execution verifies that Computer's current
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
the build lifecycle, read-only behavior, backend selector, and backend capability description. Tool configuration
explicitly disables Computer's optional `publish` capability and pins the reviewed default limits: 2,000 lines or 256
KiB per read, 2 MiB per write/edit, and 64 KiB for each exec output stream. These gates detect drift; they cannot turn a
preview dependency into a stable production contract. Computer 0.1.1's published write executor does not forward `ToolExecutionOptions.abortSignal`, so an in-flight vendor
write still relies on the workspace runtime's bounded operation. Ghostbuild's custom streamed `exec` adapter does forward
cancellation to its Container process.

## Model Context and Prefix Caching

The browser sends open, recently used, and locally modified file context as a bounded turn attachment. The server adds
that attachment only to the current model view; it never persists the generated context as a transcript message.
Ghostbuild derives compaction thresholds from the selected model window while reserving its full output budget. It
summarizes old turns into a branch-anchored checkpoint, retains about 20K recent tokens, and leaves the authoritative
transcript unchanged. Long tool loops can also compact their in-memory Pi context before another model step; an invisible
provider context-overflow response is compacted and retried once. After the response is durably persisted, the existing
recoverable fiber records an equivalent transcript checkpoint. The model reacquires authoritative facts on demand through
Computer's paged `read` tool and the bounded VFS-served `ls` and `grep` tools, which is why compaction can discard file
context cheaply: recovering it no longer costs a container round trip. Retrieved source remains untrusted project data,
and so is every path and matching line a discovery tool returns.

Workers AI prefix caching is automatic for supported models. Ghostbuild sends an opaque, stable session-affinity value
per transcript generation through either the REST header or binding `extraHeaders`, keeps system instructions at the
front of the prompt, and leaves dynamic project context in the latest user turn. Cache availability never changes the model-visible input or correctness path. Finish telemetry aggregates Pi's native
`usage.cacheRead` across model turns and reports cache hits or misses without logging prompt contents. Small historical samples observed lower affinity
latency but reported zero cached tokens, so Ghostbuild claims no verified cached-token cost savings. The retained
decision record is `scripts/evaluations/DECISIONS.md`.

## Trust Boundaries

User input, generated code, model output, and repository context are untrusted. Secrets remain in server-side
Cloudflare bindings; generated-project actions reject secret files. Generated code never executes in the Ghostbuild
control-plane Worker. Runtime capabilities are short-lived and bound to the authenticated user and browser origin.
