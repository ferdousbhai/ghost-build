type RuntimeStorage = Pick<DurableObjectStorage, 'sql' | 'transactionSync'>;

/** File metadata and backup handles live only in the user-owned runtime DO. */
export function initializeWorkspaceRuntimeSchema(storage: RuntimeStorage): void {
  storage.transactionSync(() => {
    storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS builder_workspace_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        initialized INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 0,
        reset_revision INTEGER NOT NULL DEFAULT 0,
        file_count INTEGER NOT NULL DEFAULT 0,
        total_bytes INTEGER NOT NULL DEFAULT 0,
        backup_json TEXT,
        sandbox_id TEXT,
        seed_id TEXT,
        seed_started_at INTEGER,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT OR IGNORE INTO builder_workspace_meta (id) VALUES (1);

      CREATE TABLE IF NOT EXISTS builder_workspace_files (
        path TEXT PRIMARY KEY,
        encoding TEXT NOT NULL CHECK (encoding IN ('utf8', 'base64')),
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        revision INTEGER NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS builder_workspace_changes (
        revision INTEGER NOT NULL,
        path TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('write', 'delete')),
        PRIMARY KEY (revision, path)
      );
      CREATE INDEX IF NOT EXISTS idx_builder_workspace_changes_path_revision
        ON builder_workspace_changes(path, revision DESC);

      CREATE TABLE IF NOT EXISTS builder_workspace_seed_files (
        seed_id TEXT NOT NULL,
        path TEXT NOT NULL,
        encoding TEXT NOT NULL CHECK (encoding IN ('utf8', 'base64')),
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        PRIMARY KEY (seed_id, path)
      );

      CREATE TABLE IF NOT EXISTS builder_workspace_tool_results (
        tool_call_id TEXT PRIMARY KEY,
        tool_name TEXT NOT NULL,
        args_sha256 TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS builder_workspace_validations (
        revision TEXT PRIMARY KEY,
        workspace_revision INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS retired_backups (
        backup_id TEXT PRIMARY KEY,
        delete_after INTEGER NOT NULL
      );
    `);
  });
}
