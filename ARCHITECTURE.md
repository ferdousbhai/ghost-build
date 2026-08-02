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

Ghostbuild is a control plane, not the host for customer projects. Its Worker and D1 retain only identity, encrypted
Cloudflare authorization, authentication state, connection metadata, and the registry needed to find each user's
workspace runtime. The root deployment has no R2 bucket, Container, application Durable Object, or Workflow binding.

Connecting Cloudflare provisions a workspace Worker, D1 database, R2 bucket, `BuilderAgent` Durable Objects, and
`WorkspaceSandbox` Containers in that user's Cloudflare account. The browser receives a short-lived, origin-bound
capability and communicates directly with that Worker for chat, project, preview, and deployment operations. Cloudflare
meters those resources to the user's account.

## State Ownership

| State                                                                                                | Authoritative owner                                 |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Identity, OAuth credentials, sessions, connection metadata, runtime registry                         | Ghostbuild control-plane D1                         |
| Chat catalog, transcript identity, deployment plans and resources, Agent garbage-collection queue    | User workspace D1                                   |
| Agent messages, turn state, compaction, and resumable execution                                      | User-owned `BuilderAgent` DO SQLite                 |
| Project manifest, numeric revision, change index, replay results, validation receipts, backup handle | User-owned `WorkspaceSandbox` DO SQLite             |
| Current project bytes and briefly retained replaced backups                                          | User-owned R2, as Sandbox `DirectoryBackup` objects |
| Dependency installation, validation, preview, and deployment processes                               | User-owned `WorkspaceSandbox` Containers            |
| Collection replicas and editor files                                                                 | Rebuildable browser SQLite/cache                    |
| Generated application's Worker, D1, R2, Agent, and related resources                                 | User's Cloudflare account                           |

Do not create a second authoritative store for the same state. Browser and process-local materializations must be
rebuildable from their owner. The workspace DO stores file metadata and a current backup handle, never file contents.

## Project Lifecycle

`BuilderAgent` owns conversation execution and delegates project operations to the project `WorkspaceSandbox`. A file
mutation restores the current backup into the Sandbox, applies the requested changes, creates a replacement
`DirectoryBackup`, and then atomically advances workspace metadata. Replaced backups are retained only for the bounded
grace period needed by in-flight operations and are deleted afterward. There is no application-level ZIP archive or
duplicate project blob in the control plane.

Model tools and editor reads use the same workspace API. Browser saves use compare-and-swap against the numeric
revision the browser loaded; a conflict refreshes from the user runtime and never overwrites newer state. TanStack DB
collections combine the server query collection with a per-account browser SQLite persistence layer. That local data is
a performance and offline-start replica, not an authority.

Dependency installation restores a backup into a user-owned Sandbox and writes a new lockfile backup. Validation,
preview, and deployment each restore an exact backup into an operation-specific Sandbox. Validation receipts bind to a
content digest, so deployment cannot proceed after the project changes.

## Preview Boundary

A preview Sandbox restores the exact project backup, builds the dedicated Vite preview, starts the preview process,
and exposes it through a Cloudflare Sandbox tunnel. The user workspace Worker returns the tunnel URL to the authenticated
browser and schedules expiry after 15 minutes. Stopping, expiry, or replacement destroys the preview process and tunnel.

Preview work and bandwidth remain in the user's Cloudflare account. OAuth credentials and control-plane secrets are
not passed to generated project processes.

## Deployment Boundary

Deployment planning and approval are recorded in the user workspace D1. Execution restores the exact validated backup
inside a user-owned Sandbox, repeats the production checks, provisions the requested resources through the user's
Cloudflare API authorization, applies migrations, and publishes with Wrangler. Ghostbuild stores no deployment archive.

The deployment executor derives resource names and security-sensitive configuration on the server. It records managed
Worker intent before publishing, then reads back the deployed version, script etag, bindings, variables, and schedules.
Ambiguous publish outcomes remain visible for owner review rather than being silently discarded.

## Generated-Application Boundary

`template/` is an independent application with its own Worker, Agent, migrations, dependencies, and Wrangler
configuration. Generated applications keep user application data in `DB` and Agent sessions, retention state, and
inference accounting in the separately provisioned `AGENT_SECURITY_DB`. Only the AppAgent runtime may import the
security binding; the protected build policy checks the resolved module graph so aliases and dependencies cannot widen
that capability boundary.

Root dependencies do not implicitly apply to the template. A template change is complete only when the bundled
Builder workspace module has been regenerated and standalone verification passes.

## Trust Boundaries

User input, generated code, model output, and repository context are untrusted. Secrets remain in server-side
Cloudflare bindings; generated-project actions reject secret files. Generated code never executes in the Ghostbuild
control-plane Worker. Runtime capabilities are short-lived and bound to the authenticated user and browser origin.
