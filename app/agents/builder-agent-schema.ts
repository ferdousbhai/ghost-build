type BuilderAgentSchemaStorage = Pick<DurableObjectStorage, 'sql' | 'transactionSync'>;

type BuilderAgentInitializationContext = Pick<DurableObjectState, 'blockConcurrencyWhile' | 'storage'>;

type SchemaMigration = {
  version: number;
  name: string;
  apply(sql: SqlStorage): void;
};

const MIGRATION_TABLE = '_ghostbuild_builder_schema_migrations';

const migrations: readonly SchemaMigration[] = [
  {
    version: 1,
    name: 'create_builder_turns',
    apply(sql) {
      sql.exec(`
        CREATE TABLE IF NOT EXISTS builder_turns (
          id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL,
          chat_initial_id TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          continuation INTEGER NOT NULL,
          first_user_message INTEGER NOT NULL,
          message_count INTEGER NOT NULL,
          last_user_message_preview TEXT,
          recovery_incident_id TEXT,
          recovery_attempt INTEGER,
          recovery_kind TEXT,
          partial_text_length INTEGER,
          error TEXT
        )
      `);
    },
  },
  {
    version: 2,
    name: 'create_builder_context_state',
    apply(sql) {
      sql.exec(`
        CREATE TABLE IF NOT EXISTS builder_context_state (
          id TEXT PRIMARY KEY,
          summary TEXT,
          from_message_id TEXT,
          to_message_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
    },
  },
  {
    version: 3,
    name: 'create_builder_workspace',
    apply(sql) {
      sql.exec(`
        CREATE TABLE IF NOT EXISTS builder_workspace_meta (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          initialized INTEGER NOT NULL DEFAULT 0,
          revision INTEGER NOT NULL DEFAULT 0,
          reset_revision INTEGER NOT NULL DEFAULT 0,
          file_count INTEGER NOT NULL DEFAULT 0,
          total_bytes INTEGER NOT NULL DEFAULT 0,
          seed_id TEXT,
          seed_started_at INTEGER,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT OR IGNORE INTO builder_workspace_meta (id) VALUES (1);

        CREATE TABLE IF NOT EXISTS builder_workspace_files (
          path TEXT PRIMARY KEY,
          content TEXT,
          encoding TEXT NOT NULL CHECK (encoding IN ('utf8', 'base64')),
          size INTEGER NOT NULL,
          sha256 TEXT NOT NULL,
          r2_key TEXT,
          revision INTEGER NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          CHECK ((content IS NULL) != (r2_key IS NULL))
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
          content TEXT,
          encoding TEXT NOT NULL CHECK (encoding IN ('utf8', 'base64')),
          size INTEGER NOT NULL,
          sha256 TEXT NOT NULL,
          r2_key TEXT,
          PRIMARY KEY (seed_id, path),
          CHECK ((content IS NULL) != (r2_key IS NULL))
        );

        CREATE TABLE IF NOT EXISTS builder_workspace_tool_results (
          tool_call_id TEXT PRIMARY KEY,
          tool_name TEXT NOT NULL,
          args_sha256 TEXT NOT NULL,
          result_json TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
    },
  },
  {
    version: 4,
    name: 'create_builder_workspace_validations',
    apply(sql) {
      sql.exec(`
        CREATE TABLE IF NOT EXISTS builder_workspace_validations (
          revision TEXT PRIMARY KEY,
          workspace_revision INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
    },
  },
];

type AppliedMigration = {
  version: number;
  name: string;
};

/**
 * Gate BuilderAgent startup on its local SQLite schema. Cloudflare delivers no
 * other events to this Durable Object until the callback resolves.
 */
export function initializeBuilderAgentSchema(ctx: BuilderAgentInitializationContext): void {
  ctx.blockConcurrencyWhile(async () => {
    runBuilderAgentSchemaMigrations(ctx.storage);
  });
}
/** Apply every pending BuilderAgent schema change exactly once and in order. */
export function runBuilderAgentSchemaMigrations(storage: BuilderAgentSchemaStorage): void {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const applied = [
    ...storage.sql.exec<AppliedMigration>(`
      SELECT version, name
      FROM ${MIGRATION_TABLE}
      ORDER BY version ASC
    `),
  ];
  assertCompatibleMigrationHistory(applied);

  for (const migration of migrations.slice(applied.length)) {
    storage.transactionSync(() => {
      migration.apply(storage.sql);
      storage.sql.exec(
        `INSERT INTO ${MIGRATION_TABLE} (version, name) VALUES (?, ?)`,
        migration.version,
        migration.name,
      );
    });
  }
}

function assertCompatibleMigrationHistory(applied: readonly AppliedMigration[]): void {
  for (const [index, recorded] of applied.entries()) {
    const expected = migrations[index];
    if (!expected || recorded.version !== expected.version || recorded.name !== expected.name) {
      throw new Error(
        `Unsupported BuilderAgent schema migration history at version ${recorded.version} (${recorded.name}).`,
      );
    }
  }
}
