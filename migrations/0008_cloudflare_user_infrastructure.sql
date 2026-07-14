CREATE TABLE IF NOT EXISTS cloudflare_credentials (
  handle TEXT PRIMARY KEY,
  ciphertext_base64 TEXT NOT NULL,
  iv_base64 TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  rotated_at INTEGER
);

CREATE TABLE IF NOT EXISTS cloudflare_connections (
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
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cloudflare_connections_user_status
ON cloudflare_connections(user_id, status);

CREATE TABLE IF NOT EXISTS cloudflare_connection_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  provider_session_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'expired', 'error')),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cloudflare_connection_sessions_user_status
ON cloudflare_connection_sessions(user_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS cloudflare_billing_authorizations (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES cloudflare_connections(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'revoked', 'expired', 'error')),
  provider_authorization_id TEXT,
  currency TEXT NOT NULL,
  spend_limit_cents INTEGER NOT NULL CHECK (spend_limit_cents > 0),
  terms_version TEXT,
  terms_accepted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cloudflare_billing_authorizations_connection_status
ON cloudflare_billing_authorizations(connection_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES cloudflare_connections(id),
  billing_authorization_id TEXT REFERENCES cloudflare_billing_authorizations(id),
  snapshot_key TEXT,
  status TEXT NOT NULL CHECK (
    status IN (
      'planned',
      'awaiting_approval',
      'approved',
      'provisioning',
      'building',
      'deploying',
      'succeeded',
      'failed',
      'canceled'
    )
  ),
  plan_json TEXT NOT NULL,
  plan_digest TEXT NOT NULL,
  approved_digest TEXT,
  approved_at INTEGER,
  production_url TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deployments_user_created_at
ON deployments(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_deployments_chat_created_at
ON deployments(chat_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_deployments_status_updated_at
ON deployments(status, updated_at);

CREATE TABLE IF NOT EXISTS deployment_resources (
  id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL,
  logical_name TEXT NOT NULL,
  provider_resource_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(deployment_id, resource_type, logical_name)
);

CREATE INDEX IF NOT EXISTS idx_deployment_resources_deployment
ON deployment_resources(deployment_id);

-- Ghostbuild-funded inference is capped per UTC day for both guest and signed-in
-- users. Costs use nano-dollars so current per-token model prices remain exact
-- without floating-point accounting. Connected users bypass this allowance and
-- run inference against their own Cloudflare account instead.
CREATE TABLE IF NOT EXISTS ai_daily_usage (
  subject_key TEXT NOT NULL,
  usage_date TEXT NOT NULL,
  charged_cost_nanodollars INTEGER NOT NULL DEFAULT 0 CHECK (charged_cost_nanodollars >= 0),
  reserved_cost_nanodollars INTEGER NOT NULL DEFAULT 0 CHECK (reserved_cost_nanodollars >= 0),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  cached_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  last_notified_threshold INTEGER NOT NULL DEFAULT 0 CHECK (last_notified_threshold IN (0, 50, 90)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(subject_key, usage_date)
);

CREATE TABLE IF NOT EXISTS ai_usage_reservations (
  id TEXT PRIMARY KEY,
  subject_key TEXT NOT NULL,
  usage_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'settled', 'released')),
  reserved_cost_nanodollars INTEGER NOT NULL CHECK (reserved_cost_nanodollars > 0),
  actual_cost_nanodollars INTEGER CHECK (actual_cost_nanodollars >= 0),
  created_at INTEGER NOT NULL,
  settled_at INTEGER,
  FOREIGN KEY(subject_key, usage_date) REFERENCES ai_daily_usage(subject_key, usage_date) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_reservations_subject_status
ON ai_usage_reservations(subject_key, usage_date, status);
