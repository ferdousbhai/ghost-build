CREATE TABLE IF NOT EXISTS chat_backup_admissions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  reserved_bytes INTEGER NOT NULL CHECK (reserved_bytes >= 0),
  reserved_objects INTEGER NOT NULL DEFAULT 0 CHECK (reserved_objects >= 0),
  operation TEXT NOT NULL DEFAULT 'upload' CHECK (operation IN ('upload', 'clone')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'released')),
  policy_violation INTEGER NOT NULL DEFAULT 0 CHECK (policy_violation IN (0, 1)),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  reserved_at INTEGER,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_chat_backup_admissions_owner_operation_created
ON chat_backup_admissions(owner_id, operation, created_at);

CREATE INDEX IF NOT EXISTS idx_chat_backup_admissions_pending_expiry
ON chat_backup_admissions(status, expires_at, id);

CREATE TABLE IF NOT EXISTS chat_backup_objects (
  storage_key TEXT PRIMARY KEY,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('message-history', 'snapshot')),
  size_source TEXT NOT NULL CHECK (size_source IN ('measured', 'estimated')),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_backup_objects_estimated
ON chat_backup_objects(size_source, storage_key);

-- Physical R2 objects are shared by cloned projects. Quota is therefore
-- attributed independently to every tenant that retains a logical reference.
CREATE TABLE IF NOT EXISTS chat_backup_object_attributions (
  owner_id TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  admission_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, storage_key),
  FOREIGN KEY (storage_key) REFERENCES chat_backup_objects(storage_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_backup_attributions_owner
ON chat_backup_object_attributions(owner_id, storage_key);

CREATE INDEX IF NOT EXISTS idx_chat_backup_attributions_admission
ON chat_backup_object_attributions(admission_id, owner_id, storage_key);

CREATE TABLE IF NOT EXISTS chat_backup_reconciliation_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  source_index INTEGER NOT NULL CHECK (source_index BETWEEN 0 AND 4),
  cursor_key TEXT NOT NULL,
  cursor_owner_id TEXT NOT NULL,
  measurement_cursor_key TEXT NOT NULL,
  discovery_passes INTEGER NOT NULL DEFAULT 0,
  last_discovery_completed_at INTEGER,
  backfill_completed_at INTEGER,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO chat_backup_reconciliation_state (
  id, source_index, cursor_key, cursor_owner_id, measurement_cursor_key, discovery_passes,
  last_discovery_completed_at, backfill_completed_at, updated_at
)
VALUES (1, 0, '', '', '', 0, NULL, NULL, 0);
