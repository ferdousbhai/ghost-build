CREATE TABLE app_resource_gc_candidates (
  chat_id TEXT PRIMARY KEY,
  not_before INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);

CREATE INDEX idx_app_resource_gc_due
ON app_resource_gc_candidates(not_before, chat_id);

-- Projects removed before this migration must receive the same provider cleanup.
INSERT INTO app_resource_gc_candidates (chat_id, not_before, created_at, attempts)
SELECT id, 0, 0, 0 FROM chats WHERE is_deleted = 1;
