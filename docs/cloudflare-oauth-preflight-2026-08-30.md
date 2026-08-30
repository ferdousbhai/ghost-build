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

## Scope catalog fetched (same day, authorized cloudflare-api MCP)

With the operator's explicit approval, the official Cloudflare API MCP server was authorized
(its own OAuth flow, consent screen observed live) and `GET /oauth/scopes` was fetched through
it - no token ever reached this repository or the session transcript.

- Catalog: **383 scope IDs**, checked in verbatim as
  `docs/cloudflare-oauth-scope-catalog-2026-08-30.tsv` (id, category, display name; sorted).
- SHA-256 of the checked-in TSV: `63843689e99c1ac765e8ecc28c7054f1d7a4aa47a3dae8f01dae7370bcad2ee5`.
- All 8 core manifest IDs are present verbatim. `offline_access` is not in the catalog - it is
  an OAuth protocol scope, not a permission, confirming the manifest's treatment.
- Registrar registration authority is `registrar-domains.admin` (plus `.read`, and sandbox
  variants) - an Admin access level, matching the plan's approval-gating for purchases.
- Access levels observed beyond read/write: admin, bind, edit, evaluate, index, metadata_read,
  monitoring, purge, report, revoke, run, send, shield, location - the broad-profile generator
  must not assume a read/write dichotomy.

The MCP server's own consent screen (a live example of a broad-grant consent) showed 194
requested permissions across 13 categories with a REQUIRED section (User Read, Background
Access) and an ADDITIONAL ACCESS section with per-category expansion and an Edit Permissions
control - the consent UX the plan's Phase 3 copy must anticipate.

## Still unverified (needs a staging consent run with the Ghostbuild client)

1. Whether Ghostbuild's token response or callback carries the granted `scope` string once
   optional scopes exist, and its exact contents in Full access / Read only / custom-partial
   consent modes.
2. Authorize-URL size with the full catalog requested.
3. A Ghostbuild-issued access token as direct bearer auth against
   `https://mcp.cloudflare.com/mcp` (the Claude Code MCP client authenticated successfully with
   the server's own client, which proves the endpoint and flow but not Ghostbuild's token).
4. Refresh behaviour and `insufficient_scope` reporting for partial grants.
