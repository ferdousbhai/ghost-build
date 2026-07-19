CREATE INDEX IF NOT EXISTS idx_cloudflare_auth_sessions_expires
ON cloudflare_auth_sessions(expires_at);

CREATE INDEX IF NOT EXISTS idx_cloudflare_oauth_states_expires
ON cloudflare_oauth_states(expires_at);

CREATE INDEX IF NOT EXISTS idx_cloudflare_credentials_created
ON cloudflare_credentials(created_at);

CREATE INDEX IF NOT EXISTS idx_cloudflare_connections_credential_handle
ON cloudflare_connections(credential_handle)
WHERE credential_handle IS NOT NULL;
