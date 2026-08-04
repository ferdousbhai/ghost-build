CREATE TABLE launch_controls (
  key TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('off', 'cohort', 'all')),
  cohort_basis_points INTEGER NOT NULL DEFAULT 0 CHECK (cohort_basis_points BETWEEN 0 AND 10000),
  cohort_salt TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO launch_controls (key, mode, cohort_basis_points, cohort_salt, updated_at)
VALUES ('cloudflare_computer', 'off', 0, 'ghostbuild-computer-launch-v1', unixepoch() * 1000);
