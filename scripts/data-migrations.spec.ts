import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncInstance } from 'node:sqlite';
import { describe, expect, test } from 'vitest';

describe('Cloudflare data deduplication migrations', () => {
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
