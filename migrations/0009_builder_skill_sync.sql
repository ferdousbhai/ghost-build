-- The upstream builder-skill mirror moved off the retired ghostbuild-ops Worker, so its
-- publication lease and its run receipts now live beside the rest of the control plane.
CREATE TABLE builder_skill_sync_state (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
  published_revisions_json TEXT NOT NULL,
  source_config_fingerprint TEXT NOT NULL,
  expected_generation TEXT,
  last_observed_revisions_json TEXT NOT NULL,
  last_checked_at INTEGER NOT NULL,
  active_run_id TEXT,
  active_run_started_at INTEGER
);

CREATE TABLE builder_skill_sync_runs (
  id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'unchanged', 'published', 'busy', 'error')),
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  source_revisions_json TEXT,
  previous_generation TEXT,
  generation TEXT,
  file_count INTEGER,
  error TEXT
);

CREATE INDEX idx_builder_skill_sync_runs_completed
ON builder_skill_sync_runs(completed_at DESC);
