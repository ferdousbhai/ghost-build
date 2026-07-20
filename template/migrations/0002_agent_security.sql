CREATE TABLE app_agent_sessions (
  token_hash TEXT PRIMARY KEY NOT NULL CHECK (length(token_hash) = 64),
  agent_name TEXT NOT NULL UNIQUE CHECK (length(agent_name) BETWEEN 16 AND 80),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX app_agent_sessions_expires_at_idx
  ON app_agent_sessions (expires_at);

CREATE TABLE app_agent_rate_limits (
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK (count > 0),
  PRIMARY KEY (bucket, window_start)
);

CREATE INDEX app_agent_rate_limits_window_start_idx
  ON app_agent_rate_limits (window_start);
