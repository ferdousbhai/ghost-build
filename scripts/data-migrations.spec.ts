import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncInstance } from 'node:sqlite';
import { describe, expect, test } from 'vitest';

describe('Cloudflare data deduplication migrations', () => {
  test('applies the complete ordered root migration history to a fresh foreign-key-enabled database', () => {
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (location: string) => DatabaseSyncInstance;
    };
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    const migrationNames = rootMigrationNames();

    expect(migrationNames.map((name) => Number.parseInt(name.slice(0, 4), 10))).toEqual(
      Array.from({ length: migrationNames.length }, (_, index) => index + 1),
    );
    for (const name of migrationNames) {
      db.exec(migration(name));
    }

    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  test('preserves applied migration history and repairs the destructive authentication rollout additively', async () => {
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (location: string) => DatabaseSyncInstance;
    };
    const fresh = new DatabaseSync(':memory:');
    fresh.exec(migration('0002_better_auth.sql'));
    fresh.exec(migration('0008_cloudflare_user_infrastructure.sql'));
    fresh.exec(migration('0011_cloudflare_auth.sql'));
    fresh.exec(migration('0017_restore_rollout_compatibility.sql'));
    fresh.exec(migration('0018_cloudflare_oauth_callback_checkpoint.sql'));

    expect(compatibilityTableNames(fresh)).toEqual(ROLLOUT_COMPATIBILITY_TABLES);
    expect(fresh.prepare('PRAGMA table_info(cloudflare_oauth_states)').all()).toContainEqual(
      expect.objectContaining({ name: 'authenticated_user_id', notnull: 0 }),
    );
    expect(fresh.prepare('PRAGMA foreign_key_list(cloudflare_oauth_states)').all()).toContainEqual(
      expect.objectContaining({ from: 'authenticated_user_id', table: 'user', on_delete: 'SET NULL' }),
    );

    const upgraded = new DatabaseSync(':memory:');
    upgraded.exec(migration('0002_better_auth.sql'));
    upgraded.exec(migration('0008_cloudflare_user_infrastructure.sql'));
    for (const table of ROLLOUT_COMPATIBILITY_TABLES.toReversed()) {
      upgraded.exec(`DROP TABLE ${table}`);
    }
    upgraded.exec(migration('0017_restore_rollout_compatibility.sql'));

    expect(compatibilityTableNames(upgraded)).toEqual(ROLLOUT_COMPATIBILITY_TABLES);

    const destructiveMigrations = rootMigrationNames().filter((name) => /\bDROP\s+TABLE\b/i.test(migration(name)));
    expect(destructiveMigrations).toEqual(['0003_drop_legacy_sessions.sql', '0011_cloudflare_auth.sql']);
  });

  test('preserves message-state metadata and queues only displaced distinct R2 keys', async () => {
    const db = await databaseWithBaseSchema();
    const insert = db.prepare(
      `INSERT INTO chat_message_states (
        id, chat_id, storage_key, subchat_index, last_message_rank, part_index,
        snapshot_key, description, created_at
      ) VALUES (?, 'chat', ?, 0, 7, ?, ?, ?, ?)`,
    );
    insert.run('loser-a', 'history-preserved', 2, 'snapshot-loser', 'description preserved', 20);
    insert.run('loser-b', 'history-loser', 1, null, null, 10);
    insert.run('winner', null, 3, 'snapshot-keep', null, 30);

    db.exec(migration('0004_unique_chat_message_state_rank.sql'));

    expect(db.prepare('SELECT * FROM chat_message_states').all()).toEqual([
      expect.objectContaining({
        id: 'winner',
        storage_key: 'history-preserved',
        snapshot_key: 'snapshot-keep',
        description: 'description preserved',
      }),
    ]);
    expect(db.prepare('SELECT storage_key FROM object_gc_candidates ORDER BY storage_key').all()).toEqual([
      { storage_key: 'history-loser' },
      { storage_key: 'snapshot-loser' },
    ]);
    expect(() => insert.run('duplicate', null, 0, null, null, 40)).toThrow(/unique constraint failed/i);
  });

  test('merges duplicate social-share state and queues losing thumbnails before enforcing chat uniqueness', async () => {
    const db = await databaseWithBaseSchema();
    db.exec(migration('0004_unique_chat_message_state_rank.sql'));
    const insert = db.prepare(
      `INSERT INTO social_shares (id, chat_id, code, thumbnail_image_key, is_shared)
       VALUES (?, 'chat', ?, ?, ?)`,
    );
    insert.run('old-a', 'code-a', 'thumbnail-retained', 1);
    insert.run('old-b', 'code-b', 'thumbnail-loser', 0);
    insert.run('winner', 'code-c', null, 0);

    db.exec(migration('0006_unique_social_share_chat.sql'));

    expect(db.prepare('SELECT * FROM social_shares').all()).toEqual([
      expect.objectContaining({
        id: 'winner',
        code: 'code-c',
        thumbnail_image_key: 'thumbnail-loser',
        is_shared: 1,
      }),
    ]);
    expect(db.prepare('SELECT storage_key FROM object_gc_candidates').all()).toEqual([
      { storage_key: 'thumbnail-retained' },
    ]);
    expect(() => insert.run('duplicate', 'code-d', null, 0)).toThrow(/unique constraint failed/i);
  });

  test('clears duplicate active URL aliases before enforcing owner-scoped uniqueness', async () => {
    const db = await databaseWithBaseSchema();
    const insert = db.prepare(
      `INSERT INTO chats (id, creator_id, initial_id, url_id, timestamp)
       VALUES (?, ?, ?, ?, ?)`,
    );
    insert.run('oldest', 'owner', 'initial-a', 'shared', '2026-01-01T00:00:00.000Z');
    insert.run('newest', 'owner', 'initial-b', 'shared', '2026-01-02T00:00:00.000Z');
    insert.run('other-owner', 'other', 'initial-c', 'shared', '2026-01-03T00:00:00.000Z');

    db.exec(migration('0012_unique_active_chat_url.sql'));

    expect(db.prepare(`SELECT id, url_id FROM chats ORDER BY id`).all()).toEqual([
      { id: 'newest', url_id: null },
      { id: 'oldest', url_id: 'shared' },
      { id: 'other-owner', url_id: 'shared' },
    ]);
    expect(() => insert.run('duplicate', 'owner', 'initial-d', 'shared', '2026-01-04T00:00:00.000Z')).toThrow(
      /unique constraint failed/i,
    );
  });

  test('backfills one bounded Agent GC generation range for every transcript of a deleted chat', async () => {
    const db = await databaseWithBaseSchema();
    db.exec(migration('0004_unique_chat_message_state_rank.sql'));
    db.prepare(
      `INSERT INTO chats (id, creator_id, initial_id, timestamp, is_deleted)
       VALUES ('chat', 'owner', 'initial', '2026-01-01T00:00:00.000Z', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO chat_message_states (
         id, chat_id, subchat_index, last_message_rank, part_index, created_at
       ) VALUES ('state', 'chat', 0, 0, 0, 1)`,
    ).run();
    db.exec(migration('0010_transcript_reconciliation.sql'));
    db.prepare(
      `UPDATE chat_transcripts
       SET generation = 2, agent_name = 'initial--transcript-0-2'
       WHERE chat_id = 'chat' AND subchat_index = 0`,
    ).run();
    db.prepare(
      `INSERT INTO chat_transcripts (
         chat_id, subchat_index, generation, agent_name, transition_token, created_at, updated_at
       ) VALUES ('chat', 1, 1, 'initial--transcript-1-1', 'transition', 1, 1)`,
    ).run();

    db.exec(migration('0013_agent_gc_outbox.sql'));

    expect(
      db
        .prepare(
          `SELECT chat_id, initial_id, subchat_index, next_generation, max_generation, attempts,
                  not_before - created_at AS grace_period_ms
           FROM agent_gc_candidates ORDER BY subchat_index`,
        )
        .all(),
    ).toEqual([
      {
        chat_id: 'chat',
        initial_id: 'initial',
        subchat_index: 0,
        next_generation: 0,
        max_generation: 2,
        attempts: 0,
        grace_period_ms: 30 * 60 * 1000,
      },
      {
        chat_id: 'chat',
        initial_id: 'initial',
        subchat_index: 1,
        next_generation: 0,
        max_generation: 1,
        attempts: 0,
        grace_period_ms: 30 * 60 * 1000,
      },
    ]);
  });

  test('backfills immutable deployment execution generations only for previously approved rows', async () => {
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (location: string) => DatabaseSyncInstance;
    };
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE deployments (
        id TEXT PRIMARY KEY,
        approved_at INTEGER,
        status TEXT NOT NULL
      );
      INSERT INTO deployments (id, approved_at, status) VALUES
        ('awaiting', NULL, 'awaiting_approval'),
        ('approved', 100, 'approved'),
        ('terminal', 200, 'failed');
    `);

    db.exec(migration('0014_deployment_execution_generation.sql'));

    expect(db.prepare('SELECT id, execution_generation FROM deployments ORDER BY id').all()).toEqual([
      { id: 'approved', execution_generation: 1 },
      { id: 'awaiting', execution_generation: 0 },
      { id: 'terminal', execution_generation: 1 },
    ]);
    expect(() => db.prepare(`UPDATE deployments SET execution_generation = -1 WHERE id = 'awaiting'`).run()).toThrow(
      /check constraint failed/i,
    );

    db.prepare(`UPDATE deployments SET status = 'approved' WHERE id = 'awaiting'`).run();
    expect(db.prepare(`SELECT execution_generation FROM deployments WHERE id = 'awaiting'`).get()).toEqual({
      execution_generation: 1,
    });
    db.prepare(`UPDATE deployments SET status = 'awaiting_approval' WHERE id = 'awaiting'`).run();

    db.exec(migration('0015_deployment_build_artifact_lifecycle.sql'));

    expect(
      db
        .prepare(
          `SELECT id, execution_generation, build_artifact_key, build_artifact_generation
           FROM deployments ORDER BY id`,
        )
        .all(),
    ).toEqual([
      { id: 'approved', execution_generation: 1, build_artifact_key: null, build_artifact_generation: null },
      { id: 'awaiting', execution_generation: 1, build_artifact_key: null, build_artifact_generation: null },
      { id: 'terminal', execution_generation: 1, build_artifact_key: null, build_artifact_generation: null },
    ]);
    expect(() =>
      db.prepare(`UPDATE deployments SET build_artifact_generation = 0 WHERE id = 'approved'`).run(),
    ).toThrow(/check constraint failed/i);

    db.prepare(`UPDATE deployments SET status = 'approved' WHERE id = 'awaiting'`).run();
    expect(db.prepare(`SELECT execution_generation FROM deployments WHERE id = 'awaiting'`).get()).toEqual({
      execution_generation: 2,
    });
    db.prepare(`UPDATE deployments SET status = 'awaiting_approval' WHERE id = 'awaiting'`).run();
    db.prepare(
      `UPDATE deployments SET status = 'approved', execution_generation = execution_generation + 1 WHERE id = 'awaiting'`,
    ).run();
    expect(db.prepare(`SELECT execution_generation FROM deployments WHERE id = 'awaiting'`).get()).toEqual({
      execution_generation: 3,
    });
  });

  test('indexes stable chat-history keyset pages across concurrent inserts and cursor-row deletion', async () => {
    const db = await databaseWithBaseSchema();
    db.exec(migration('0019_chat_history_pagination.sql'));
    const insertChat = db.prepare(
      `INSERT INTO chats (id, creator_id, initial_id, timestamp)
       VALUES (?, 'owner', ?, ?)`,
    );
    const insertState = db.prepare(
      `INSERT INTO chat_message_states (
         id, chat_id, subchat_index, last_message_rank, part_index, created_at
       ) VALUES (?, ?, 0, 0, 0, 1)`,
    );
    const tiedTimestamp = '2026-02-03T04:05:06.000Z';
    for (const id of ['row-a', 'row-b', 'row-c']) {
      insertChat.run(id, `initial-${id}`, tiedTimestamp);
      insertState.run(`state-${id}`, id);
    }

    const firstPageQuery = db.prepare(
      `SELECT chats.id
       FROM chats
       WHERE chats.creator_id = ? AND chats.is_deleted = 0
         AND EXISTS (
           SELECT 1 FROM chat_message_states
           WHERE chat_message_states.chat_id = chats.id
             AND chat_message_states.last_message_rank >= 0
         )
       ORDER BY chats.timestamp DESC, chats.id DESC
       LIMIT ?`,
    );
    const nextPageQuery = db.prepare(
      `SELECT chats.id
       FROM chats
       WHERE chats.creator_id = ? AND chats.is_deleted = 0
         AND EXISTS (
           SELECT 1 FROM chat_message_states
           WHERE chat_message_states.chat_id = chats.id
             AND chat_message_states.last_message_rank >= 0
         )
         AND (chats.timestamp, chats.id) < (?, ?)
       ORDER BY chats.timestamp DESC, chats.id DESC
       LIMIT ?`,
    );

    expect(firstPageQuery.all('owner', 2)).toEqual([{ id: 'row-c' }, { id: 'row-b' }]);
    db.prepare(`DELETE FROM chats WHERE id = 'row-b'`).run();
    insertChat.run('row-d', 'initial-row-d', '2026-02-04T04:05:06.000Z');
    insertState.run('state-row-d', 'row-d');

    expect(nextPageQuery.all('owner', tiedTimestamp, 'row-b', 2)).toEqual([{ id: 'row-a' }]);
    expect(firstPageQuery.all('owner', 2)).toEqual([{ id: 'row-d' }, { id: 'row-c' }]);

    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT chats.id
         FROM chats
         WHERE chats.creator_id = ? AND chats.is_deleted = 0
           AND EXISTS (
             SELECT 1 FROM chat_message_states
             WHERE chat_message_states.chat_id = chats.id
               AND chat_message_states.last_message_rank >= 0
           )
           AND (chats.timestamp, chats.id) < (?, ?)
         ORDER BY chats.timestamp DESC, chats.id DESC
         LIMIT ?`,
      )
      .all('owner', tiedTimestamp, 'row-b', 2) as Array<{ detail: string }>;
    expect(plan.some(({ detail }) => detail.includes('idx_chats_creator_deleted_history'))).toBe(true);
  });

  test('indexes every bounded Cloudflare authorization retention predicate', async () => {
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (location: string) => DatabaseSyncInstance;
    };
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE cloudflare_auth_sessions (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE cloudflare_oauth_states (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE cloudflare_credentials (handle TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
      CREATE TABLE cloudflare_connections (id TEXT PRIMARY KEY, credential_handle TEXT);
    `);

    db.exec(migration('0016_cloudflare_auth_retention.sql'));

    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'index' AND name LIKE 'idx_cloudflare_%'
           ORDER BY name`,
        )
        .all(),
    ).toEqual([
      { name: 'idx_cloudflare_auth_sessions_expires' },
      { name: 'idx_cloudflare_connections_credential_handle' },
      { name: 'idx_cloudflare_credentials_created' },
      { name: 'idx_cloudflare_oauth_states_expires' },
    ]);
  });
});

async function databaseWithBaseSchema() {
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (location: string) => DatabaseSyncInstance;
  };
  const db = new DatabaseSync(':memory:');
  db.exec(migration('0001_cloudflare_data.sql'));
  return db;
}

function migration(name: string): string {
  return readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
}

function rootMigrationNames(): string[] {
  return readdirSync(new URL('../migrations/', import.meta.url))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
}

const ROLLOUT_COMPATIBILITY_TABLES = [
  'account',
  'ai_daily_usage',
  'ai_usage_reservations',
  'cloudflare_connection_sessions',
  'session',
  'verification',
];

function compatibilityTableNames(db: DatabaseSyncInstance): string[] {
  return db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN (${ROLLOUT_COMPATIBILITY_TABLES.map(() => '?').join(', ')})
       ORDER BY name`,
    )
    .all(...ROLLOUT_COMPATIBILITY_TABLES)
    .map((row) => (row as { name: string }).name);
}
