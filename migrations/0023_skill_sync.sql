CREATE TABLE IF NOT EXISTS skill_sync_state (
  source_id TEXT PRIMARY KEY,
  repository TEXT NOT NULL,
  branch TEXT NOT NULL,
  upstream_tree_sha TEXT CHECK (
    upstream_tree_sha IS NULL OR length(upstream_tree_sha) = 40
  ),
  active_release_sha256 TEXT CHECK (
    active_release_sha256 IS NULL OR length(active_release_sha256) = 64
  ),
  previous_release_sha256 TEXT CHECK (
    previous_release_sha256 IS NULL OR length(previous_release_sha256) = 64
  ),
  status TEXT NOT NULL CHECK (status IN ('pending', 'current', 'failed')),
  last_checked_at INTEGER,
  last_changed_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_sync_entries (
  source_id TEXT NOT NULL REFERENCES skill_sync_state(source_id) ON DELETE CASCADE,
  doc_key TEXT NOT NULL,
  upstream_path TEXT NOT NULL,
  upstream_blob_sha TEXT NOT NULL CHECK (length(upstream_blob_sha) = 40),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  storage_key TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (source_id, doc_key),
  UNIQUE (source_id, upstream_path)
);

INSERT OR IGNORE INTO skill_sync_state (
  source_id,
  repository,
  branch,
  status,
  created_at,
  updated_at
) VALUES (
  'cloudflare-skills',
  'cloudflare/skills',
  'main',
  'pending',
  0,
  0
);
