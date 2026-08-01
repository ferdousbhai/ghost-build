CREATE TABLE "user" (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  emailVerified INTEGER NOT NULL,
  image TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  cloudflare_subject TEXT
);

CREATE UNIQUE INDEX idx_user_cloudflare_subject
ON "user"(cloudflare_subject) WHERE cloudflare_subject IS NOT NULL;

CREATE TABLE cloudflare_credentials (
  handle TEXT PRIMARY KEY,
  ciphertext_base64 TEXT NOT NULL,
  iv_base64 TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  rotated_at INTEGER
);

CREATE INDEX idx_cloudflare_credentials_created
ON cloudflare_credentials(created_at);

CREATE TABLE cloudflare_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES "user"(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  account_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('linking', 'active', 'revoked', 'error')),
  credential_handle TEXT REFERENCES cloudflare_credentials(handle),
  granted_scopes_json TEXT NOT NULL DEFAULT '[]',
  ai_billing_enabled INTEGER NOT NULL DEFAULT 0 CHECK (ai_billing_enabled IN (0, 1)),
  connected_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  connection_generation INTEGER NOT NULL DEFAULT 1 CHECK (connection_generation > 0)
);

CREATE INDEX idx_cloudflare_connections_user_status
ON cloudflare_connections(user_id, status);
CREATE INDEX idx_cloudflare_connections_credential_handle
ON cloudflare_connections(credential_handle) WHERE credential_handle IS NOT NULL;

CREATE TABLE cloudflare_auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_cloudflare_auth_sessions_user_expires
ON cloudflare_auth_sessions(user_id, expires_at DESC);
CREATE INDEX idx_cloudflare_auth_sessions_expires
ON cloudflare_auth_sessions(expires_at);

CREATE TABLE cloudflare_oauth_states (
  id TEXT PRIMARY KEY,
  provider_session_id TEXT NOT NULL UNIQUE,
  return_to TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'expired', 'error')),
  expires_at INTEGER NOT NULL,
  authenticated_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_cloudflare_oauth_states_status_expires
ON cloudflare_oauth_states(status, expires_at);
CREATE INDEX idx_cloudflare_oauth_states_expires
ON cloudflare_oauth_states(expires_at);

CREATE TABLE user_workspace_runtimes (
  user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES cloudflare_connections(id) ON DELETE CASCADE,
  connection_generation INTEGER NOT NULL CHECK (connection_generation > 0),
  worker_name TEXT NOT NULL,
  bucket_name TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  runtime_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('provisioning', 'ready', 'error')),
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(connection_id, connection_generation)
);

CREATE INDEX idx_user_workspace_runtimes_connection
ON user_workspace_runtimes(connection_id, connection_generation, status);
