# Cloudflare OAuth Phase 0 preflight — dashboard capture

Date: 2026-08-30
Method: read-only inspection of the Cloudflare dashboard (Manage account → OAuth clients)
by the account operator's browser session. Nothing was changed or saved; the edit wizard
was abandoned without touching "Save changes".

## Ghostbuild OAuth client (verified live configuration)

- Client ID: `b18c394ddf1a34600f65da6f1e475873`
- Name: Ghostbuild — Public, Verified (DNS TXT `cloudflare_oauth_client_publisher=…` present)
- Response type: Code
- Grant types: Authorization Code, Refresh Token
- Token endpoint auth: Client Secret Basic
- Redirect (callback) URL: `https://ghostbuild.dev/connect/return` (exactly one)
- Client URL: `https://ghostbuild.dev`

## Configured scopes (9)

Matches `CORE_CLOUDFLARE_OAUTH_SCOPES` in
`app/lib/.server/cloudflare/cloudflare-oauth-scope-manifest.ts`, plus `offline_access`,
which is configured on the client itself (listed under "Other" in the scopes view), not
only appended at authorize time:

- Developer Platform: D1 Write (`d1.write`), Workers Containers Write (`containers.write`),
  Workers KV Storage Write (`workers-kv-storage.write`), Workers R2 Storage Write
  (`workers-r2.write`), Workers Scripts Write (`workers-scripts.write`)
- AI & Machine Learning: Workers AI Read (`ai.read`)
- Account & Billing: Account Settings Read (`account-settings.read`), User Details Read
  (`user-details.read`)
- Other: `offline_access`

## Optional-scope state (decisive for the orchestrator fallback)

The "Choose optional scopes" step reads: **"All 8 permissions are required."** No configured
scope is optional. This proves the invariant `resolveGrantedScopes` relies on when Cloudflare
reports no granted-scope string: a completed exchange carries exactly the requested set,
because the user cannot decline any of it and still complete authorization. The moment any
scope is marked optional, that fallback must fail instead (the code already does).

The step offers "Mark all as optional" and per-scope Required toggles, confirming the
optional-scope mechanism from Cloudflare's 2026-08-20 GA is available to this client.

## Scope catalog shape (from the "Select permission scopes" step)

The selectable catalog is far larger than the configured set. Categories and current
selection counts: Developer Platform 5/30 · AI & Machine Learning 1/8 · DNS & Zones ·
App Security · Rules & Configuration · Cloudflare One / Zero Trust · Analytics & Logs ·
Network Services · Media · Email & Messaging · Cache & Performance · Account & Billing 2/9 ·
Other. Permission groups expose access levels named Edit / Read, with some offering
Run, Admin, Bind, Revoke, Purge, Send, Report, Evaluate, or Integration. Notable for the
plan's later phases:

- Registrar: "Registrar Domains — Admin, Read" and "Registrar Sandbox Domains — Admin, Read"
  (under DNS & Zones); registration authority is an Admin-level permission.
- Zero Trust / Access, Magic WAN/Transit, Email, Media, Zone and Billing categories all
  exist as expected for the broad profile.
- Rough scale: ~200 permission groups across ~13 categories, i.e. several hundred scope IDs.

## Still unverified (needs an API credential or a staging consent run)

1. Exact scope IDs for the broad profile: the dashboard shows display names, not IDs.
   The authoritative list is `GET https://api.cloudflare.com/client/v4/oauth/scopes`
   (Bearer token). The checked-in manifest must be generated from that response with a
   recorded digest.
2. Whether the token response or callback carries the granted `scope` string once optional
   scopes exist, and its exact contents in Full access / Read only / custom-partial consent
   modes (staging consent runs).
3. Authorize-URL size with the full catalog requested.
4. A Ghostbuild-issued access token as direct bearer auth against
   `https://mcp.cloudflare.com/mcp` (tool discovery + harmless read).
5. Refresh behaviour and `insufficient_scope` reporting for partial grants.
