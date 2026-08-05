# Cloudflare Computer beta rollout

`@cloudflare/computer@0.1.1` is a preview-only dependency. The accountable
launch owner is GitHub maintainer `@ferdousbhai`; the required technical
reviewer is the engineer responsible for the user-owned Cloudflare runtime.
Either may stop rollout. The migration installs this gate in `off` mode.

The next formal review date is **2026-08-11**. Access may increase only if
Computer has a stable upstream release, or the accountable owner records a
dated, time-bounded beta-risk acceptance after every go/no check below passes.
Any beta-risk acceptance expires no later than **2026-08-18** and must be
renewed against the then-current upstream release and production evidence.

## Active beta-risk acceptance

The launch owner accepted the `@cloudflare/computer@0.1.1` preview risk for a
public beta on **2026-08-04**. This acceptance expires on **2026-08-18**. It
does not represent an upstream stability guarantee or approval for a broader
production-readiness claim. Recheck the installed release and every go/no-go
item before renewal.

## Mutable control

The `launch_controls.cloudflare_computer` D1 row is checked before issuing a
user-runtime capability and before provisioning a runtime. Changes take effect
without a Worker deployment. Existing capabilities expire after their normal
short lifetime. The gate cannot interrupt an already-established WebSocket or
an in-flight turn, so an emergency stop denies new sessions immediately but is
not a hard kill switch for work already executing. Use the bounded turn and
tool timeouts as the containment window, and revoke the affected user runtime
when immediate termination is required.

Emergency stop:

```sh
pnpm exec wrangler d1 execute ghostbuild --remote --command \
  "UPDATE launch_controls SET mode = 'off', cohort_basis_points = 0, updated_at = unixepoch() * 1000 WHERE key = 'cloudflare_computer'"
```

Deterministic 10% cohort:

```sh
pnpm exec wrangler d1 execute ghostbuild --remote --command \
  "UPDATE launch_controls SET mode = 'cohort', cohort_basis_points = 1000, updated_at = unixepoch() * 1000 WHERE key = 'cloudflare_computer'"
```

Full beta access:

```sh
pnpm exec wrangler d1 execute ghostbuild --remote --command \
  "UPDATE launch_controls SET mode = 'all', cohort_basis_points = 10000, updated_at = unixepoch() * 1000 WHERE key = 'cloudflare_computer' AND mode = 'off' AND cohort_basis_points = 0 AND cohort_salt = 'ghostbuild-computer-launch-v1'; SELECT changes() AS changed_rows"
```

Require `changed_rows = 1`, then read the exact row back after every write:

```sh
pnpm exec wrangler d1 execute ghostbuild --remote --command \
  "SELECT key, mode, cohort_basis_points, cohort_salt, updated_at FROM launch_controls WHERE key = 'cloudflare_computer'"
```

Never change `cohort_salt` during a live
cohort experiment because that reshuffles every assignment.

## Go/no-go checks

Before increasing access, require all of the following:

1. Exact dependency and tool-schema canaries pass for `read`, `ls`, `write`,
   `edit`, and the container `exec` backend.
2. User-runtime readiness is green for D1, Durable Object RPC, Computer VFS,
   container-shell, FUSE, and a completed sync.
3. The build validates from a clean checkout, generated runtime source matches,
   and production configuration checks pass.
4. A sentinel workspace can write, read, execute, read back, and delete a
   non-user file without exposing file contents in telemetry.
5. No increase appears in typed tool failures, pending/exhausted syncs,
   turn-budget exhaustion, runtime provisioning failures, preview failures, or
   deployment attestation failures.

## Telemetry and privacy

Operational events may contain only event names, bounded stage/reason enums,
durations, counts, byte counts, revisions, dependency/runtime versions, and
non-reversible salted fingerprints. Do not log prompts, source or diff content,
file paths, commands, stdout/stderr, OAuth credentials, capability tokens,
asset upload JWTs, user identifiers, Worker URLs, or raw provider errors.

Page the launch owner and set the gate to `off` when any credential can reach a
project-controlled process, a deployment readback differs from the requested
version, a mutation reports success while sync is pending or exhausted, or a
cross-project identity mismatch occurs. Reduce to the previous cohort for a
sustained error-rate or latency regression; do not mask it with retries.

## Rollback

The rollback is access denial, not a legacy-tool fallback. This repository
intentionally broke compatibility with the removed custom filesystem tools.
After switching the gate off, preserve failed durable state for inspection,
stop new provisioning, fix forward, rebuild the generated runtime, validate,
and then reopen a small deterministic cohort.

Primary references:

- [Cloudflare Computer README](https://github.com/cloudflare/computer/blob/main/packages/computer/README.md)
- [Computer tool interface](https://github.com/cloudflare/computer/blob/main/docs/09_tool_interface.md)
- [Computer container example](https://github.com/cloudflare/computer/tree/main/examples/container)
