CREATE TABLE upstream_monitor_runs (
  id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'attention', 'error')),
  started_at INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  summary_json TEXT,
  error TEXT
);

CREATE INDEX idx_upstream_monitor_runs_completed
ON upstream_monitor_runs(completed_at DESC);
