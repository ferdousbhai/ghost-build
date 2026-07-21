ALTER TABLE chat_backup_admissions
ADD COLUMN intake_reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK (intake_reserved_bytes >= 0);

CREATE INDEX IF NOT EXISTS idx_chat_backup_admissions_owner_pending_intake
ON chat_backup_admissions(owner_id, status, intake_reserved_bytes);

CREATE TABLE IF NOT EXISTS thumbnail_upload_admissions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  intake_reserved_bytes INTEGER NOT NULL CHECK (intake_reserved_bytes >= 0),
  reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
  reserved_objects INTEGER NOT NULL DEFAULT 0 CHECK (reserved_objects BETWEEN 0 AND 1),
  expected_storage_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'released')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  reserved_at INTEGER,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_thumbnail_admissions_owner_created
ON thumbnail_upload_admissions(owner_id, created_at);

CREATE INDEX IF NOT EXISTS idx_thumbnail_admissions_owner_pending
ON thumbnail_upload_admissions(owner_id, status, intake_reserved_bytes);

CREATE INDEX IF NOT EXISTS idx_thumbnail_admissions_pending_expiry
ON thumbnail_upload_admissions(status, expires_at, id);

CREATE TABLE IF NOT EXISTS thumbnail_objects (
  storage_key TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  admission_id TEXT,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'retained', 'released')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_thumbnail_objects_owner_status
ON thumbnail_objects(owner_id, status, storage_key);

CREATE INDEX IF NOT EXISTS idx_thumbnail_objects_admission
ON thumbnail_objects(admission_id, storage_key);

CREATE TABLE IF NOT EXISTS thumbnail_reconciliation_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cursor_key TEXT NOT NULL,
  discovery_passes INTEGER NOT NULL DEFAULT 0,
  last_discovery_completed_at INTEGER,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO thumbnail_reconciliation_state (
  id, cursor_key, discovery_passes, last_discovery_completed_at, updated_at
) VALUES (1, '', 0, NULL, 0);
