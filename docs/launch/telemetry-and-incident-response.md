# Launch telemetry and incident response

This document describes the implemented engineering controls and the decisions still required before Product Hunt. It
is not a privacy policy or legal-basis determination.

## Implemented telemetry contract

Browsers send `POST /api/client-telemetry` using a credential-free keepalive fetch, so Ghostbuild session and retired
prompt cookies are not attached. The Worker accepts only the checked-in event enum, page class, opaque UUID
journey/error-event IDs, status fields, and bounded non-negative metrics. The strict schema rejects extra properties.
Prompts, generated code, URLs, user/account/project identifiers, credentials, tokens, exception messages, and raw tool
output have no accepted field. Browser telemetry is off by default and is emitted only after the user sets
`localStorage['ghostbuild:telemetry:preference']` to `enabled` through the Privacy-page control. Global Privacy Control
and Do Not Track override that opt-in and disable emission. The endpoint requires an exact same-origin browser `Origin`
header, uses the Cloudflare-supplied client IP only as the 60-second rate-limit key, allows up to 120 requests per IP per
minute before parsing, and caps each body at 8 KiB. The IP is not included in the application event log.
These are abuse and cost controls, not proof that an analytics event is truthful; funnel and SLO data remains
operationally indicative rather than an authenticated ledger.

The launch funnel is:

`landing_viewed → cloudflare_connect_started → prompt_submitted → first_tool_completed → validation_succeeded → preview_ready → deployment_approval_presented → deployment_approved → deployment_succeeded`

When browser telemetry is enabled, operational failures use the existing typed event names, an error level, a generic
failure reason where available, and an opaque per-event ID. The journey ID groups events from one browser-session
journey; neither identifier is an incident record. Cloudflare Worker logs are the current ingestion store.
`app/lib/client-telemetry-events.test.ts` fails if a declared event loses every production call site.

Before launch, the operator must configure a dashboard with conversion and latency by funnel stage and these initial
engineering objectives:

- 99.9% successful control-plane request availability over 30 days.
- 99% successful authenticated prompt admission, excluding explicit user cancellation.
- 95% of first successful tool completions within the agreed staging budget.
- 99% preview-ready success for validated revisions and 99% deployment success after approval.
- Error-budget burn alerts at 2% over one hour and 5% over 15 minutes, grouped by event and failure reason and
  deduplicated by the per-event ID.

Cloudflare Workers Logs automatically retains data for three days on Workers Free or seven days on Workers Paid, with a
maximum retention of seven days. Ghostbuild does not copy these logs to another store. An August 4, 2026 account-member
readback showed one member, the sole Super Administrator, so no other account member currently has log access. Recheck
both facts whenever the plan or account membership changes.

The exact latency budget, dashboard URLs, alert destinations, paging schedule, and backup owner are external operational
configuration and remain launch blockers until recorded here. `ferdousbhai` is the public-beta primary owner. The
twice-weekday contact-channel inspection and remaining notification drills are recorded in
`contact-channel-operations.md`.

## Incident procedure

1. Declare severity, start an incident record, name the incident commander, and assign an opaque incident ID in that
   record. This operator-assigned ID is separate from browser telemetry error-event IDs. Do not
   copy prompts, code, tokens, or raw tool output into chat or tickets.
2. Confirm scope with Worker logs and `pnpm exec wrangler tail ghostbuild --format json --search client_telemetry`.
   Correlate related browser events by journey ID, event, failure reason, time window, and deployment version; attach
   only the operator-assigned incident ID in the restricted incident record, not user content.
3. Stop release activity. For a control-plane regression, inspect versions with
   `pnpm exec wrangler deployments list --name ghostbuild`, then run
   `pnpm exec wrangler rollback <known-good-version-id> --name ghostbuild --message "incident rollback"` after the
   incident commander confirms the exact version.
4. Contain deployment incidents by stopping approvals/releases and revoking affected credentials through the normal
   Cloudflare connection controls. Never delete customer-owned Workers, D1, R2, Containers, or Agents as an inferred
   cleanup action.
5. Communicate initial impact, affected surface, safe workaround, and next update time through the published support and
   security channels. Their business-day acknowledgement goals are operational targets, not 24/7 incident-response or
   contractual service-level guarantees.
6. Verify recovery using the built-browser smoke gate and the staging critical journey. Monitor one full error-budget
   window before resolving.
7. Within two working days, write a blameless review covering timeline, detection gap, containment, customer impact,
   corrective owners/dates, and whether this runbook or a test gate failed.

## Containment limits

There is no global process kill switch for user-owned runtimes. An established WebSocket or in-flight bounded turn can
continue until it settles, times out, or the operator revokes that runtime. During an incident, halt releases and use
Cloudflare operator controls only for the exact affected Worker after confirming ownership and scope. A staging drill
must inject client, Agent, sync, preview, validation, and deployment failures and verify redaction, correlation,
containment, dashboard alerts, rollback, and customer communication before launch.
