-- Project files and build execution live in a Worker, Sandbox container, and
-- R2 bucket owned by the connected user's Cloudflare account. This table is
-- deliberately control-plane metadata only: it must never contain backup
-- handles, paths, file manifests, file contents, or build artifacts.
CREATE TABLE user_workspace_runtimes (
  user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES cloudflare_connections(id) ON DELETE CASCADE,
  connection_generation INTEGER NOT NULL,
  worker_name TEXT NOT NULL,
  bucket_name TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  runtime_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('provisioning', 'ready', 'error')),
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(connection_id, connection_generation)
);

CREATE INDEX idx_user_workspace_runtimes_connection
ON user_workspace_runtimes(connection_id, connection_generation, status);
