import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  admitThumbnailUpload,
  prepareReleaseThumbnailForChatStatement,
  publishThumbnailReplacement,
  reconcileThumbnailQuota,
  registerThumbnailUploadObject,
  releaseThumbnailAdmissionBestEffort,
  reserveThumbnailReplacement,
} from './thumbnail-quota.server';

describe('thumbnail quota and ownership accounting', () => {
  let database: TestD1Database;
  let head: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    database = new TestD1Database();
    head = vi.fn().mockResolvedValue({ size: 128 });
    database.insertChat('chat-a', 'owner');
    database.insertShare('share-a', 'chat-a', null);
  });

  test('atomically reserves tenant-wide intake before body materialization and releases failures', async () => {
    database.insertChat('chat-b', 'owner');
    database.insertChat('chat-c', 'owner');
    const env = thumbnailEnv(database, head);
    const first = await admitThumbnailUpload(env, { ownerId: 'owner', chatId: 'chat-a', now: 10_000 });
    const second = await admitThumbnailUpload(env, { ownerId: 'owner', chatId: 'chat-b', now: 10_000 });

    await expect(admitThumbnailUpload(env, { ownerId: 'owner', chatId: 'chat-c', now: 10_000 })).rejects.toMatchObject({
      kind: 'in-flight',
    });
    expect(
      database.sqlite
        .prepare(
          `SELECT COUNT(*) AS requests, SUM(intake_reserved_bytes) AS bytes
           FROM thumbnail_upload_admissions WHERE owner_id = 'owner' AND status = 'pending'`,
        )
        .get(),
    ).toEqual({ requests: 2, bytes: 10 * 1024 * 1024 });

    await releaseThumbnailAdmissionBestEffort(database.db, first);
    await expect(admitThumbnailUpload(env, { ownerId: 'owner', chatId: 'chat-c', now: 10_000 })).resolves.toMatchObject(
      {
        chatId: 'chat-c',
      },
    );
    await releaseThumbnailAdmissionBestEffort(database.db, second);
  });

  test('measures legacy ownership and reserves the full physical replacement until old-object GC', async () => {
    database.sqlite
      .prepare(`UPDATE social_shares SET thumbnail_image_key = 'thumbnails/old' WHERE id = 'share-a'`)
      .run();
    head.mockResolvedValueOnce({ size: 128 });
    const env = thumbnailEnv(database, head);
    let admission = await admitThumbnailUpload(env, { ownerId: 'owner', chatId: 'chat-a', now: 10_000 });

    expect(head).toHaveBeenCalledWith('thumbnails/old');
    expect(database.sqlite.prepare(`SELECT size_bytes, status FROM thumbnail_objects`).get()).toEqual({
      size_bytes: 128,
      status: 'retained',
    });

    admission = await reserveThumbnailReplacement(database.db, admission, {
      sizeBytes: 64,
      expectedStorageKey: 'thumbnails/old',
      now: 10_001,
    });
    expect(admission).toMatchObject({ reservedBytes: 64, reservedObjects: 1 });
    await registerThumbnailUploadObject(database.db, {
      admission,
      storageKey: 'thumbnails/new',
      sizeBytes: 64,
      now: 10_002,
    });
    await expect(
      publishThumbnailReplacement(database.db, {
        admission,
        storageKey: 'thumbnails/new',
        sizeBytes: 64,
        displacedStorageKey: 'thumbnails/old',
        gcStatements: [],
        now: 10_003,
      }),
    ).resolves.toBe('published');

    expect(
      database.sqlite.prepare(`SELECT storage_key, size_bytes FROM thumbnail_objects WHERE status = 'retained'`).all(),
    ).toEqual([{ storage_key: 'thumbnails/new', size_bytes: 64 }]);
    expect(
      database.sqlite
        .prepare(`SELECT storage_key, size_bytes, status FROM thumbnail_objects ORDER BY storage_key`)
        .all(),
    ).toEqual([
      { storage_key: 'thumbnails/new', size_bytes: 64, status: 'retained' },
      { storage_key: 'thumbnails/old', size_bytes: 128, status: 'released' },
    ]);
    expect(database.sqlite.prepare(`SELECT status FROM thumbnail_upload_admissions`).get()).toEqual({
      status: 'completed',
    });
  });

  test('atomically includes other pending replacement deltas in the tenant retained-byte cap', async () => {
    database.insertChat('chat-b', 'owner');
    database.insertShare('share-b', 'chat-b', null);
    const env = thumbnailEnv(database, head);
    const admissions = await Promise.all([
      admitThumbnailUpload(env, { ownerId: 'owner', chatId: 'chat-a', now: 10_000 }),
      admitThumbnailUpload(env, { ownerId: 'owner', chatId: 'chat-b', now: 10_000 }),
    ]);
    database.sqlite
      .prepare(
        `INSERT INTO thumbnail_objects (
           storage_key, owner_id, chat_id, admission_id, size_bytes, status, created_at, updated_at
         ) VALUES ('seed', 'owner', 'seed-chat', NULL, ?, 'retained', 1, 1)`,
      )
      .run(252 * 1024 * 1024);

    const results = await Promise.allSettled(
      admissions.map((admission) =>
        reserveThumbnailReplacement(database.db, admission, {
          sizeBytes: 3 * 1024 * 1024,
          expectedStorageKey: null,
          now: 10_001,
        }),
      ),
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: expect.objectContaining({ kind: 'storage' }),
    });
  });

  test('counts released and registered-pending objects without double-counting their admission reservations', async () => {
    const env = thumbnailEnv(database, head);
    database.sqlite
      .prepare(
        `INSERT INTO thumbnail_objects (
           storage_key, owner_id, chat_id, admission_id, size_bytes, status, created_at, updated_at
         ) VALUES ('released', 'owner', 'old-chat', NULL, ?, 'released', 1, 1)`,
      )
      .run(250 * 1024 * 1024);
    let first = await admitThumbnailUpload(env, { ownerId: 'owner', chatId: 'chat-a', now: 10_000 });
    first = await reserveThumbnailReplacement(database.db, first, {
      sizeBytes: 3 * 1024 * 1024,
      expectedStorageKey: null,
      now: 10_001,
    });
    await registerThumbnailUploadObject(database.db, {
      admission: first,
      storageKey: 'pending',
      sizeBytes: 3 * 1024 * 1024,
      now: 10_002,
    });
    database.insertChat('chat-b', 'owner');
    database.insertShare('share-b', 'chat-b', null);
    const second = await admitThumbnailUpload(env, { ownerId: 'owner', chatId: 'chat-b', now: 10_003 });

    await expect(
      reserveThumbnailReplacement(database.db, second, {
        sizeBytes: 3 * 1024 * 1024,
        expectedStorageKey: null,
        now: 10_004,
      }),
    ).resolves.toMatchObject({ reservedBytes: 3 * 1024 * 1024, reservedObjects: 1 });
    await releaseThumbnailAdmissionBestEffort(database.db, first);
    await releaseThumbnailAdmissionBestEffort(database.db, second);
    database.insertChat('chat-c', 'owner');
    database.insertShare('share-c', 'chat-c', null);
    const third = await admitThumbnailUpload(env, { ownerId: 'owner', chatId: 'chat-c', now: 10_005 });
    await expect(
      reserveThumbnailReplacement(database.db, third, {
        sizeBytes: 4 * 1024 * 1024,
        expectedStorageKey: null,
        now: 10_006,
      }),
    ).rejects.toMatchObject({ kind: 'storage' });
    expect(
      database.sqlite
        .prepare(`SELECT SUM(size_bytes) AS bytes, COUNT(*) AS objects FROM thumbnail_objects WHERE owner_id = 'owner'`)
        .get(),
    ).toEqual({ bytes: 253 * 1024 * 1024, objects: 2 });
  });

  test('keeps failed physical uploads charged and never age-purges them before confirmed R2 deletion', async () => {
    const env = thumbnailEnv(database, head);
    let admission = await admitThumbnailUpload(env, { ownerId: 'owner', chatId: 'chat-a', now: 10_000 });
    admission = await reserveThumbnailReplacement(database.db, admission, {
      sizeBytes: 64,
      expectedStorageKey: null,
      now: 10_001,
    });
    await registerThumbnailUploadObject(database.db, {
      admission,
      storageKey: 'thumbnails/failed',
      sizeBytes: 64,
      now: 10_002,
    });
    await releaseThumbnailAdmissionBestEffort(database.db, admission);

    await reconcileThumbnailQuota(env, { now: 3 * 24 * 60 * 60 * 1_000, limit: 32 });

    expect(database.sqlite.prepare(`SELECT size_bytes, status FROM thumbnail_objects`).get()).toEqual({
      size_bytes: 64,
      status: 'released',
    });
  });

  test('keeps publication CAS, attribution transfer, and chat deletion release in one D1 transaction', async () => {
    const env = thumbnailEnv(database, head);
    let admission = await admitThumbnailUpload(env, { ownerId: 'owner', chatId: 'chat-a', now: 10_000 });
    admission = await reserveThumbnailReplacement(database.db, admission, {
      sizeBytes: 64,
      expectedStorageKey: null,
      now: 10_001,
    });
    await registerThumbnailUploadObject(database.db, {
      admission,
      storageKey: 'thumbnails/new',
      sizeBytes: 64,
      now: 10_002,
    });
    await publishThumbnailReplacement(database.db, {
      admission,
      storageKey: 'thumbnails/new',
      sizeBytes: 64,
      displacedStorageKey: null,
      gcStatements: [],
      now: 10_003,
    });

    await database.db.batch([
      prepareReleaseThumbnailForChatStatement(database.db, { chatId: 'chat-a', ownerId: 'owner', now: 10_004 }),
      database.db.prepare(`DELETE FROM social_shares WHERE chat_id = ?`).bind('chat-a'),
    ]);
    expect(database.sqlite.prepare(`SELECT status FROM thumbnail_objects`).get()).toEqual({ status: 'released' });
  });

  test('does not publish against a stale replacement target', async () => {
    const env = thumbnailEnv(database, head);
    let admission = await admitThumbnailUpload(env, { ownerId: 'owner', chatId: 'chat-a', now: 10_000 });
    admission = await reserveThumbnailReplacement(database.db, admission, {
      sizeBytes: 64,
      expectedStorageKey: null,
      now: 10_001,
    });
    await registerThumbnailUploadObject(database.db, {
      admission,
      storageKey: 'thumbnails/new',
      sizeBytes: 64,
      now: 10_002,
    });
    database.sqlite
      .prepare(`UPDATE social_shares SET thumbnail_image_key = 'thumbnails/concurrent' WHERE chat_id = 'chat-a'`)
      .run();

    await expect(
      publishThumbnailReplacement(database.db, {
        admission,
        storageKey: 'thumbnails/new',
        sizeBytes: 64,
        displacedStorageKey: null,
        gcStatements: [],
        now: 10_003,
      }),
    ).resolves.toBe('stale');
    expect(database.sqlite.prepare(`SELECT thumbnail_image_key FROM social_shares`).get()).toEqual({
      thumbnail_image_key: 'thumbnails/concurrent',
    });
  });

  test('bounds scheduled legacy discovery and releases expired admissions', async () => {
    const env = thumbnailEnv(database, head);
    const admission = await admitThumbnailUpload(env, { ownerId: 'owner', chatId: 'chat-a', now: 1 });
    database.sqlite.prepare(`UPDATE thumbnail_upload_admissions SET expires_at = 2 WHERE id = ?`).run(admission.id);
    database.sqlite.prepare(`UPDATE social_shares SET thumbnail_image_key = 'thumbnails/legacy'`).run();

    await expect(reconcileThumbnailQuota(env, { now: 3, limit: 1 })).resolves.toEqual({
      releasedAdmissions: 1,
      discoveredObjects: 1,
    });
    expect(head).toHaveBeenCalledTimes(1);
  });

  test('releases the complete owner-scoped expired backlog before admitting new intake', async () => {
    const insert = database.sqlite.prepare(
      `INSERT INTO thumbnail_upload_admissions (
         id, owner_id, chat_id, intake_reserved_bytes, reserved_bytes, reserved_objects,
         expected_storage_key, status, created_at, expires_at, reserved_at, completed_at
       ) VALUES (?, 'owner', 'stale-chat', ?, 0, 0, NULL, 'pending', 1, 2, NULL, NULL)`,
    );
    for (let index = 0; index < 96; index++) {
      insert.run(`stale-${index}`, 5 * 1024 * 1024);
    }

    await expect(
      admitThumbnailUpload(thumbnailEnv(database, head), {
        ownerId: 'owner',
        chatId: 'chat-a',
        now: 2 * 24 * 60 * 60 * 1_000,
      }),
    ).resolves.toMatchObject({ ownerId: 'owner' });
    expect(
      database.sqlite
        .prepare(
          `SELECT COUNT(*) AS count FROM thumbnail_upload_admissions WHERE owner_id = 'owner' AND status = 'pending'`,
        )
        .get(),
    ).toEqual({ count: 1 });
  });
});

function thumbnailEnv(database: TestD1Database, head: ReturnType<typeof vi.fn>) {
  return { DB: database.db, APP_STORAGE: { head } as unknown as R2Bucket };
}

class TestD1Database {
  readonly sqlite = new DatabaseSync(':memory:');
  private batchTail: Promise<void> = Promise.resolve();

  constructor() {
    this.sqlite.exec(`
      CREATE TABLE chats (
        id TEXT PRIMARY KEY,
        creator_id TEXT NOT NULL,
        is_deleted INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE social_shares (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL UNIQUE,
        code TEXT NOT NULL UNIQUE,
        thumbnail_image_key TEXT,
        is_shared INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE chat_message_states (chat_id TEXT NOT NULL, storage_key TEXT, snapshot_key TEXT);
      CREATE TABLE shares (chat_id TEXT NOT NULL, chat_history_key TEXT, snapshot_key TEXT);
    `);
    this.sqlite.exec(
      readFileSync(new URL('../../../../migrations/0020_chat_backup_quota.sql', import.meta.url), 'utf8'),
    );
    this.sqlite.exec(
      readFileSync(new URL('../../../../migrations/0022_upload_resource_quotas.sql', import.meta.url), 'utf8'),
    );
  }

  insertChat(id: string, ownerId: string): void {
    this.sqlite.prepare(`INSERT INTO chats (id, creator_id, is_deleted) VALUES (?, ?, 0)`).run(id, ownerId);
  }

  insertShare(id: string, chatId: string, storageKey: string | null): void {
    this.sqlite
      .prepare(
        `INSERT INTO social_shares (id, chat_id, code, thumbnail_image_key, is_shared)
         VALUES (?, ?, ?, ?, 0)`,
      )
      .run(id, chatId, `${id}-code`, storageKey);
  }

  readonly db = {
    prepare: (query: string) => this.prepared(query),
    batch: async (statements: D1PreparedStatement[]) => {
      const previous = this.batchTail;
      let release!: () => void;
      this.batchTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        this.sqlite.exec('BEGIN IMMEDIATE');
        try {
          const results: D1Result[] = [];
          for (const statement of statements) {
            results.push(await statement.run());
          }
          this.sqlite.exec('COMMIT');
          return results;
        } catch (error) {
          this.sqlite.exec('ROLLBACK');
          throw error;
        }
      } finally {
        release();
      }
    },
  } as unknown as D1Database;

  private prepared(query: string): D1PreparedStatement {
    const execute = (values: unknown[]) => {
      const statement = this.sqlite.prepare(query);
      return {
        run: async () => {
          const result = statement.run(...(values as SQLInputValue[]));
          return { success: true, meta: { changes: Number(result.changes) } } as D1Result;
        },
        first: async <T>() => (statement.get(...(values as SQLInputValue[])) as T | undefined) ?? null,
        all: async <T>() =>
          ({
            success: true,
            results: statement.all(...(values as SQLInputValue[])) as T[],
            meta: {},
          }) as D1Result<T>,
      };
    };
    const unbound = execute([]);
    return {
      bind: (...values: unknown[]) => execute(values) as unknown as D1PreparedStatement,
      run: unbound.run,
      first: unbound.first,
      all: unbound.all,
    } as unknown as D1PreparedStatement;
  }
}
