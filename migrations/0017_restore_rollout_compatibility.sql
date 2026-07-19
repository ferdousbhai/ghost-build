-- Early deployments of 0011 removed tables still queried by the previously
-- deployed Worker. Recreate their empty schemas so a failed deployment or
-- rollback remains operational. Fresh installations retained these tables in
-- the corrected 0011 migration, making every statement below a no-op.

CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY NOT NULL,
  userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expiresAt DATE NOT NULL,
  ipAddress TEXT,
  userAgent TEXT,
  createdAt DATE NOT NULL,
  updatedAt DATE NOT NULL
);

CREATE INDEX IF NOT EXISTS session_userId_idx ON session(userId);

CREATE TABLE IF NOT EXISTS account (
  id TEXT PRIMARY KEY NOT NULL,
  userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  accountId TEXT NOT NULL,
  providerId TEXT NOT NULL,
  accessToken TEXT,
  refreshToken TEXT,
  accessTokenExpiresAt DATE,
  refreshTokenExpiresAt DATE,
  scope TEXT,
  idToken TEXT,
  password TEXT,
  createdAt DATE NOT NULL,
  updatedAt DATE NOT NULL
);

CREATE INDEX IF NOT EXISTS account_userId_idx ON account(userId);

CREATE TABLE IF NOT EXISTS verification (
  id TEXT PRIMARY KEY NOT NULL,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expiresAt DATE NOT NULL,
  createdAt DATE,
  updatedAt DATE
);

CREATE INDEX IF NOT EXISTS verification_identifier_idx ON verification(identifier);

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
