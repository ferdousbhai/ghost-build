-- The Worker cron fires every 15 minutes for authentication-metadata retention. Jobs that used
-- to be a separate daily cron claim a slot here instead, so a claim survives a deployment and a
-- missed tick delays a run rather than losing it.
CREATE TABLE daily_maintenance_jobs (
  job TEXT PRIMARY KEY NOT NULL,
  last_started_at INTEGER NOT NULL
);

-- The account-anchored sweep has no dashboard any more, so every run leaves a receipt local
-- tooling can read. `orphans_json` is a bounded sample of `[{"userId","kind","name"}]`;
-- `orphans_found` is the true total even when the sample is truncated.
CREATE TABLE app_resource_reconcile_runs (
  id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'error')),
  mode TEXT NOT NULL CHECK (mode IN ('report', 'enforce')),
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  users_scanned INTEGER NOT NULL DEFAULT 0,
  users_failed INTEGER NOT NULL DEFAULT 0,
  resources_scanned INTEGER NOT NULL DEFAULT 0,
  orphans_found INTEGER NOT NULL DEFAULT 0,
  orphans_json TEXT,
  deleted_count INTEGER NOT NULL DEFAULT 0,
  listing_skipped INTEGER NOT NULL DEFAULT 0 CHECK (listing_skipped IN (0, 1)),
  error TEXT
);

CREATE INDEX idx_app_resource_reconcile_runs_started
ON app_resource_reconcile_runs(started_at DESC);
