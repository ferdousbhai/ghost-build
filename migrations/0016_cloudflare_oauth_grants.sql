-- What Cloudflare actually granted, separate from Ghostbuild product capabilities.
--
-- The legacy granted_scopes_json column recorded the *requested* Ghostbuild capability names
-- (workers, d1, ...), never OAuth scope IDs, so no existing row carries an authoritative record
-- of the provider grant. Capabilities backfill into their own column; the OAuth grant for every
-- legacy row is 'unknown' with no scope IDs, which requires a fresh authorization before any
-- feature can rely on a provider-confirmed scope. Existing workspace provisioning and deployment
-- read only capabilities and keep working while reauthorization is pending.
--
-- granted_scopes_json remains and continues to receive the capability list so a still-serving
-- previous deployment reads a coherent connection during rollout.
ALTER TABLE cloudflare_connections ADD COLUMN granted_capabilities_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE cloudflare_connections ADD COLUMN requested_oauth_scopes_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE cloudflare_connections ADD COLUMN granted_oauth_scopes_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE cloudflare_connections ADD COLUMN oauth_scope_profile_version TEXT;
ALTER TABLE cloudflare_connections ADD COLUMN oauth_scope_grant_status TEXT NOT NULL DEFAULT 'unknown'
  CHECK (oauth_scope_grant_status IN ('unknown', 'core', 'partial', 'full'));
ALTER TABLE cloudflare_connections ADD COLUMN oauth_grant_updated_at INTEGER;

UPDATE cloudflare_connections
SET granted_capabilities_json = granted_scopes_json
WHERE granted_capabilities_json = '[]';
