CREATE TABLE user_computer_runtimes (
  user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES cloudflare_connections(id) ON DELETE CASCADE,
  connection_generation INTEGER NOT NULL CHECK (connection_generation > 0),
  worker_name TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  runtime_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('provisioning', 'ready', 'error')),
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(connection_id, connection_generation)
);

CREATE INDEX idx_user_computer_runtimes_connection
ON user_computer_runtimes(connection_id, connection_generation, status);
