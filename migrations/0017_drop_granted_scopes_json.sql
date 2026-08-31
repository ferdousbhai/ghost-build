-- Nothing reads or writes granted_scopes_json any more: product capabilities live in
-- granted_capabilities_json and provider-confirmed OAuth scope IDs in granted_oauth_scopes_json
-- (0016). The dual-write that kept this column coherent for a still-serving previous deployment
-- was removed pre-launch, deliberately, with no compatibility window to honor - so the dormant
-- legacy column goes away rather than accreting.
ALTER TABLE cloudflare_connections DROP COLUMN granted_scopes_json;
