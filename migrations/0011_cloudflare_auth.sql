ALTER TABLE "user" ADD COLUMN cloudflare_subject TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_cloudflare_subject
ON "user"(cloudflare_subject)
WHERE cloudflare_subject IS NOT NULL;

CREATE TABLE IF NOT EXISTS cloudflare_auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cloudflare_auth_sessions_user_expires
ON cloudflare_auth_sessions(user_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS cloudflare_oauth_states (
  id TEXT PRIMARY KEY,
  provider_session_id TEXT NOT NULL UNIQUE,
  return_to TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'expired', 'error')),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cloudflare_oauth_states_status_expires
ON cloudflare_oauth_states(status, expires_at);

-- Cloudflare OAuth now creates the Ghostbuild identity and session directly.
-- Remove Better Auth provider/session state and the superseded signed-in-only
-- Cloudflare linking state. Existing users remain in "user" so ownership can
-- be adopted by matching the verified Cloudflare email on first authorization.
DROP TABLE IF EXISTS account;
DROP TABLE IF EXISTS verification;
DROP TABLE IF EXISTS session;
DROP TABLE IF EXISTS cloudflare_connection_sessions;

-- Ghostbuild no longer funds or meters builder inference.
DROP TABLE IF EXISTS ai_usage_reservations;
DROP TABLE IF EXISTS ai_daily_usage;
