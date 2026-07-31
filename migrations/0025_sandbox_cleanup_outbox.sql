CREATE TABLE IF NOT EXISTS sandbox_cleanup_candidates (
  sandbox_id TEXT PRIMARY KEY NOT NULL,
  lease_token TEXT NOT NULL,
  operation TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'cleanup')),
  not_before INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_sandbox_cleanup_candidates_due
ON sandbox_cleanup_candidates(status, not_before, sandbox_id);

-- Adopt previews created before this outbox existed. Active admissions include
-- both ready previews and builds that stopped between admission and preview-row
-- registration.
INSERT OR IGNORE INTO sandbox_cleanup_candidates (
  sandbox_id,
  lease_token,
  operation,
  status,
  not_before,
  created_at,
  updated_at,
  attempts,
  last_error
)
SELECT
  sandbox_id,
  lower(hex(randomblob(16))),
  'Builder preview sandbox',
  'active',
  expires_at,
  created_at,
  created_at,
  0,
  NULL
FROM builder_preview_build_admissions
WHERE status = 'active';
