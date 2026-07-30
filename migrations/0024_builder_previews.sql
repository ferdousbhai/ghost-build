CREATE TABLE IF NOT EXISTS builder_previews (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,
  sandbox_id TEXT NOT NULL UNIQUE,
  access_token_hash TEXT NOT NULL,
  snapshot_key TEXT NOT NULL,
  workspace_revision INTEGER NOT NULL,
  snapshot_revision TEXT NOT NULL,
  port INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('building', 'ready', 'failed', 'cancelled', 'expired')),
  created_at INTEGER NOT NULL,
  ready_at INTEGER,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_builder_previews_owner_status
ON builder_previews(owner_id, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_builder_previews_agent_created
ON builder_previews(agent_name, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_builder_previews_expiration
ON builder_previews(expires_at, status);

CREATE TABLE IF NOT EXISTS builder_preview_build_admissions (
  preview_id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,
  sandbox_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'released', 'expired')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  released_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_builder_preview_admissions_capacity
ON builder_preview_build_admissions(status, expires_at);

CREATE INDEX IF NOT EXISTS idx_builder_preview_admissions_owner_usage
ON builder_preview_build_admissions(owner_id, created_at DESC);
