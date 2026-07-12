CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  category TEXT NOT NULL CHECK (category IN ('bug', 'idea', 'ux', 'other')),
  message TEXT NOT NULL,
  page_path TEXT,
  app_version TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewed', 'planned', 'closed')),
  source_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_feedback_status_created_at ON feedback(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_source_created_at ON feedback(source_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_user_created_at ON feedback(user_id, created_at DESC);
