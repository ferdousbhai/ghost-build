import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  admitChatBackupRequest,
  CHAT_BACKUP_HEAD_CONCURRENCY,
  CHAT_BACKUP_RECONCILIATION_LIMIT,
  ChatBackupQuotaError,
  type ChatBackupQuotaConfig,
  completeChatBackupAdmission,
  createChatBackupCloneQuotaExtension,
  enforceChatBackupEdgeRateLimit,
  reconcileChatBackupQuota,
  registerChatBackupObject,
  releaseChatBackupCloneAdmissionBestEffort,
  releaseChatBackupAdmissionBestEffort,
  releaseUnreferencedChatBackupAttributions,
  reserveChatBackupBytes,
  throwIfChatBackupCloneQuotaDenied,
} from './chat-backup-quota.server';

describe('chat backup quota admission', () => {
  let database: TestD1Database;

  beforeEach(() => {
    database = new TestD1Database();
  });

  test('atomically admits only the configured number of concurrent requests', async () => {
    const env = quotaEnv(database, { CHAT_BACKUP_REQUESTS_PER_MINUTE: '2' });
    const results = await Promise.allSettled(
      Array.from({ length: 3 }, (_, index) =>
        admitChatBackupRequest(env, { ownerId: 'owner', chatId: `chat-${index}`, now: 10_000 }),
      ),
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: expect.objectContaining({ kind: 'request-rate' }) });
    expect(database.sqlite.prepare('SELECT COUNT(*) AS count FROM chat_backup_admissions').get()).toEqual({ count: 2 });
  });

  test('keeps exact request limits tenant-scoped', async () => {
    const env = quotaEnv(database, { CHAT_BACKUP_REQUESTS_PER_MINUTE: '1' });

    await admitChatBackupRequest(env, { ownerId: 'owner-a', chatId: 'chat-a', now: 10_000 });
    await expect(
      admitChatBackupRequest(env, { ownerId: 'owner-b', chatId: 'chat-b', now: 10_000 }),
    ).resolves.toMatchObject({ ownerId: 'owner-b' });
  });

  test('atomically rejects a concurrent byte reservation that would cross the tenant cap', async () => {
    const env = quotaEnv(database, { CHAT_BACKUP_STORAGE_LIMIT_BYTES: '10' });
    const admissions = await Promise.all([
      admitChatBackupRequest(env, { ownerId: 'owner', chatId: 'chat-a', now: 10_000 }),
      admitChatBackupRequest(env, { ownerId: 'owner', chatId: 'chat-b', now: 10_000 }),
    ]);
    const results = await Promise.allSettled(
      admissions.map((admission) => reserveChatBackupBytes(env, admission, 6, 1, 10_000)),
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: expect.objectContaining({ kind: 'storage' }),
    });
  });

  test('atomically bounds retained object cardinality including pending reservations', async () => {
    const env = quotaEnv(database, { CHAT_BACKUP_STORAGE_LIMIT_OBJECTS: '1' });
    const admissions = await Promise.all([
      admitChatBackupRequest(env, { ownerId: 'owner', chatId: 'chat-a', now: 10_000 }),
      admitChatBackupRequest(env, { ownerId: 'owner', chatId: 'chat-b', now: 10_000 }),
    ]);

    const results = await Promise.allSettled(
      admissions.map((admission) => reserveChatBackupBytes(env, admission, 1, 1, 10_000)),
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: expect.objectContaining({ kind: 'storage' }),
    });
  });

  test('records byte-policy violations without rejecting in storage shadow mode', async () => {
    const env = quotaEnv(database, {
      CHAT_BACKUP_STORAGE_QUOTA_MODE: 'shadow',
      CHAT_BACKUP_STORAGE_LIMIT_BYTES: '1',
    });

    const admission = await admitChatBackupRequest(env, { ownerId: 'owner', chatId: 'chat', now: 10_000 });
    const byteViolation = await reserveChatBackupBytes(env, admission, 2, 1, 10_000);

    expect(byteViolation.policyViolation).toBe(true);
  });

  test('keeps the exact request limit enforced while storage accounting is in shadow mode', async () => {
    const env = quotaEnv(database, {
      CHAT_BACKUP_STORAGE_QUOTA_MODE: 'shadow',
      CHAT_BACKUP_REQUESTS_PER_MINUTE: '1',
    });

    await admitChatBackupRequest(env, { ownerId: 'owner', chatId: 'chat-a', now: 10_000 });
    await expect(
      admitChatBackupRequest(env, { ownerId: 'owner', chatId: 'chat-b', now: 10_000 }),
    ).rejects.toMatchObject({ kind: 'request-rate' });
  });

  test('enforces edge shedding independently of storage shadow mode', async () => {
    const limit = vi.fn().mockResolvedValue({ success: false });
    const env = {
      ...quotaEnv(database, { CHAT_BACKUP_STORAGE_QUOTA_MODE: 'shadow' }),
      CHAT_BACKUP_RATE_LIMITER: { limit },
    };

    await expect(enforceChatBackupEdgeRateLimit(env as unknown as Env, 'owner')).rejects.toMatchObject({
      kind: 'edge-rate',
    });
    expect(limit).toHaveBeenCalledWith({ key: 'owner' });
  });

  test('fails closed on edge denial in enforce mode', async () => {
    const env = {
      ...quotaEnv(database),
      CHAT_BACKUP_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: false }) },
    };

    await expect(enforceChatBackupEdgeRateLimit(env as unknown as Env, 'owner')).rejects.toMatchObject({
      kind: 'edge-rate',
      retryAfterSeconds: 60,
    });
  });

  test('recovers an exact admission after a lost D1 acknowledgement', async () => {
    const env = quotaEnv(database);
    database.loseNextAcknowledgementFor('INSERT INTO chat_backup_admissions');

    await expect(admitChatBackupRequest(env, { ownerId: 'owner', chatId: 'chat', now: 10_000 })).resolves.toMatchObject(
      { ownerId: 'owner' },
    );
    expect(database.sqlite.prepare('SELECT COUNT(*) AS count FROM chat_backup_admissions').get()).toEqual({ count: 1 });
  });

  test('opportunistically purges more expired owner history than each new admission creates', async () => {
    const env = quotaEnv(database);
    const insert = database.sqlite.prepare(
      `INSERT INTO chat_backup_admissions
       (id, owner_id, chat_id, reserved_bytes, status, created_at, expires_at, completed_at)
       VALUES (?, 'owner', 'chat', 0, 'completed', 1, 2, 2)`,
    );
    for (let index = 0; index < 20; index++) {
      insert.run(`old-${index}`);
    }

    await admitChatBackupRequest(env, {
      ownerId: 'owner',
      chatId: 'new-chat',
      now: 24 * 60 * 60 * 1000 + 10,
    });

    expect(database.sqlite.prepare('SELECT COUNT(*) AS count FROM chat_backup_admissions').get()).toEqual({ count: 5 });
  });

  test('recovers exact reservation, object, and completion receipts after acknowledgement loss', async () => {
    const env = quotaEnv(database);
    let admission = await admitChatBackupRequest(env, { ownerId: 'owner', chatId: 'chat', now: 10_000 });
    database.loseNextAcknowledgementFor('UPDATE chat_backup_admissions');
    admission = await reserveChatBackupBytes(env, admission, 6, 1, 10_000);
    database.loseNextBatchAcknowledgement();
    await registerChatBackupObject(database.db, {
      admission,
      storageKey: 'message-history/one',
      sizeBytes: 6,
      kind: 'message-history',
      now: 10_000,
    });
    database.loseNextAcknowledgementFor("SET status = 'completed'");

    await expect(completeChatBackupAdmission(database.db, admission, 10_000)).resolves.toBeUndefined();
    expect(database.sqlite.prepare('SELECT status FROM chat_backup_admissions').get()).toEqual({
      status: 'completed',
    });
  });

  test('validates object bytes and preserves registered objects after releasing unused reservation bytes', async () => {
    const env = quotaEnv(database);
    let admission = await admitChatBackupRequest(env, { ownerId: 'owner', chatId: 'chat', now: 10_000 });
    admission = await reserveChatBackupBytes(env, admission, 10, 1, 10_000);

    await expect(
      registerChatBackupObject(database.db, {
        admission,
        storageKey: 'message-history/one',
        sizeBytes: Number.MAX_SAFE_INTEGER,
        kind: 'message-history',
      }),
    ).rejects.toThrow(/safe nonnegative integer/);
    await registerChatBackupObject(database.db, {
      admission,
      storageKey: 'message-history/one',
      sizeBytes: 6,
      kind: 'message-history',
      now: 10_000,
    });
    await releaseChatBackupAdmissionBestEffort(database.db, admission);

    expect(database.sqlite.prepare('SELECT status FROM chat_backup_admissions').get()).toEqual({ status: 'released' });
    expect(database.sqlite.prepare('SELECT size_bytes FROM chat_backup_objects').get()).toEqual({ size_bytes: 6 });
  });

  test('completes only after every reserved byte is registered', async () => {
    const env = quotaEnv(database);
    let admission = await admitChatBackupRequest(env, { ownerId: 'owner', chatId: 'chat', now: 10_000 });
    admission = await reserveChatBackupBytes(env, admission, 10, 2, 10_000);
    await registerChatBackupObject(database.db, {
      admission,
      storageKey: 'message-history/one',
      sizeBytes: 6,
      kind: 'message-history',
      now: 10_000,
    });

    await expect(completeChatBackupAdmission(database.db, admission, 10_000)).rejects.toThrow(/Unable to complete/);
    await registerChatBackupObject(database.db, {
      admission,
      storageKey: 'snapshots/two',
      sizeBytes: 4,
      kind: 'snapshot',
      now: 10_000,
    });
    await expect(completeChatBackupAdmission(database.db, admission, 10_000)).resolves.toBeUndefined();
  });

  test('atomically attributes a cloned physical object to the recipient tenant', async () => {
    database.sqlite.exec(`
      INSERT INTO chat_backup_objects VALUES ('message-history/shared', 7, 'message-history', 'measured', 1);
      INSERT INTO chat_backup_object_attributions VALUES ('source-owner', 'message-history/shared', NULL, 1);
    `);
    const extension = createChatBackupCloneQuotaExtension(quotaEnv(database), {
      ownerId: 'clone-owner',
      chatId: 'clone-chat',
      storageKeys: ['message-history/shared'],
      now: 10_000,
    });
    const results = await database.db.batch([
      ...extension.prefixStatements,
      database.db
        .prepare(
          `INSERT INTO chats (id, creator_id, snapshot_key)
           SELECT 'clone-chat', 'clone-owner', NULL
           WHERE EXISTS (
             SELECT 1 FROM chat_backup_admissions
             WHERE id = ? AND owner_id = 'clone-owner' AND status = 'pending'
           )`,
        )
        .bind(extension.admissionId),
      ...extension.suffixStatements,
    ]);

    expect(extension.validateResults(results.slice(0, extension.prefixStatements.length), results.slice(-1))).toBe(
      true,
    );
    expect(await extension.verifyReceipt()).toBe(true);
    expect(
      database.sqlite
        .prepare(
          `SELECT owner_id FROM chat_backup_object_attributions
           WHERE storage_key = 'message-history/shared' ORDER BY owner_id`,
        )
        .all(),
    ).toEqual([{ owner_id: 'clone-owner' }, { owner_id: 'source-owner' }]);
    expect(database.sqlite.prepare('SELECT COUNT(*) AS count FROM chat_backup_objects').get()).toEqual({ count: 1 });
  });

  test('prevents a clone reference from becoming visible when the recipient object cap is exhausted', async () => {
    database.sqlite.exec(`
      INSERT INTO chat_backup_objects VALUES
        ('message-history/one', 1, 'message-history', 'measured', 1),
        ('message-history/two', 1, 'message-history', 'measured', 1);
      INSERT INTO chat_backup_object_attributions VALUES ('clone-owner', 'message-history/one', NULL, 1);
    `);
    const extension = createChatBackupCloneQuotaExtension(
      quotaEnv(database, { CHAT_BACKUP_STORAGE_LIMIT_OBJECTS: '1' }),
      {
        ownerId: 'clone-owner',
        chatId: 'denied-chat',
        storageKeys: ['message-history/two'],
        now: 10_000,
      },
    );
    const results = await database.db.batch([
      ...extension.prefixStatements,
      database.db
        .prepare(
          `INSERT INTO chats (id, creator_id, snapshot_key)
           SELECT 'denied-chat', 'clone-owner', NULL
           WHERE EXISTS (
             SELECT 1 FROM chat_backup_admissions
             WHERE id = ? AND owner_id = 'clone-owner' AND status = 'pending'
           )`,
        )
        .bind(extension.admissionId),
      ...extension.suffixStatements,
    ]);

    expect(extension.validateResults(results.slice(0, extension.prefixStatements.length), results.slice(-1))).toBe(
      false,
    );
    expect(database.sqlite.prepare(`SELECT COUNT(*) AS count FROM chats WHERE id = 'denied-chat'`).get()).toEqual({
      count: 0,
    });
    expect(
      database.sqlite
        .prepare(
          `SELECT COUNT(*) AS count FROM chat_backup_object_attributions
           WHERE owner_id = 'clone-owner' AND storage_key = 'message-history/two'`,
        )
        .get(),
    ).toEqual({ count: 0 });
    await releaseChatBackupCloneAdmissionBestEffort(database.db, {
      admissionId: extension.admissionId,
      ownerId: 'clone-owner',
    });
  });

  test('enforces one tenant-wide request limit across uploads and clones in shadow mode', async () => {
    database.sqlite.exec(`
      INSERT INTO chat_backup_objects VALUES ('message-history/shared', 7, 'message-history', 'measured', 1);
      INSERT INTO chat_backup_object_attributions VALUES ('source-owner', 'message-history/shared', NULL, 1);
    `);
    const env = quotaEnv(database, {
      CHAT_BACKUP_STORAGE_QUOTA_MODE: 'shadow',
      CHAT_BACKUP_REQUESTS_PER_MINUTE: '1',
    });
    await admitChatBackupRequest(env, { ownerId: 'clone-owner', chatId: 'upload-chat', now: 10_000 });
    const extension = createChatBackupCloneQuotaExtension(env, {
      ownerId: 'clone-owner',
      chatId: 'clone-chat',
      storageKeys: ['message-history/shared'],
      now: 10_000,
    });

    const results = await database.db.batch([
      ...extension.prefixStatements,
      database.db
        .prepare(
          `INSERT INTO chats (id, creator_id, snapshot_key)
           SELECT 'clone-chat', 'clone-owner', NULL
           WHERE EXISTS (
             SELECT 1 FROM chat_backup_admissions WHERE id = ? AND owner_id = 'clone-owner' AND status = 'pending'
           )`,
        )
        .bind(extension.admissionId),
      ...extension.suffixStatements,
    ]);

    expect(extension.validateResults(results.slice(0, extension.prefixStatements.length), results.slice(-1))).toBe(
      false,
    );
    expect(database.sqlite.prepare(`SELECT COUNT(*) AS count FROM chats WHERE id = 'clone-chat'`).get()).toEqual({
      count: 0,
    });
    await expect(
      throwIfChatBackupCloneQuotaDenied(env, {
        admissionId: extension.admissionId,
        ownerId: 'clone-owner',
        storageKeys: ['message-history/shared'],
        now: 10_000,
      }),
    ).rejects.toMatchObject({ kind: 'request-rate' });
  });

  test('atomically rate-limits concurrent repeated clones even when their shared object reservation becomes zero', async () => {
    database.sqlite.exec(`
      INSERT INTO chat_backup_objects VALUES ('message-history/shared', 7, 'message-history', 'measured', 1);
      INSERT INTO chat_backup_object_attributions VALUES ('source-owner', 'message-history/shared', NULL, 1);
    `);
    const env = quotaEnv(database, {
      CHAT_BACKUP_STORAGE_QUOTA_MODE: 'shadow',
      CHAT_BACKUP_REQUESTS_PER_MINUTE: '1',
    });
    const extensions = ['clone-a', 'clone-b'].map((chatId) => ({
      chatId,
      extension: createChatBackupCloneQuotaExtension(env, {
        ownerId: 'clone-owner',
        chatId,
        storageKeys: ['message-history/shared'],
        now: 10_000,
      }),
    }));

    const outcomes = await Promise.all(
      extensions.map(async ({ chatId, extension }) => {
        const results = await database.db.batch([
          ...extension.prefixStatements,
          database.db
            .prepare(
              `INSERT INTO chats (id, creator_id, snapshot_key)
               SELECT ?, 'clone-owner', NULL
               WHERE EXISTS (
                 SELECT 1 FROM chat_backup_admissions
                 WHERE id = ? AND owner_id = 'clone-owner' AND status = 'pending'
               )`,
            )
            .bind(chatId, extension.admissionId),
          ...extension.suffixStatements,
        ]);
        return extension.validateResults(results.slice(0, extension.prefixStatements.length), results.slice(-1));
      }),
    );

    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(
      database.sqlite
        .prepare(`SELECT COUNT(*) AS count FROM chat_backup_admissions WHERE owner_id = ? AND operation = 'clone'`)
        .get('clone-owner'),
    ).toEqual({ count: 1 });
    expect(
      database.sqlite.prepare(`SELECT COUNT(*) AS count FROM chats WHERE creator_id = 'clone-owner'`).get(),
    ).toEqual({ count: 1 });
  });

  test('counts clones against the exact daily upload limit after the minute window passes', async () => {
    database.sqlite.exec(`
      INSERT INTO chat_backup_objects VALUES ('message-history/shared', 7, 'message-history', 'measured', 1);
      INSERT INTO chat_backup_object_attributions VALUES ('source-owner', 'message-history/shared', NULL, 1);
    `);
    const env = quotaEnv(database, {
      CHAT_BACKUP_STORAGE_QUOTA_MODE: 'shadow',
      CHAT_BACKUP_REQUESTS_PER_MINUTE: '10',
      CHAT_BACKUP_REQUESTS_PER_DAY: '1',
    });
    const extension = createChatBackupCloneQuotaExtension(env, {
      ownerId: 'owner',
      chatId: 'clone-chat',
      storageKeys: ['message-history/shared'],
      now: 10_000,
    });
    const results = await database.db.batch([
      ...extension.prefixStatements,
      database.db
        .prepare(
          `INSERT INTO chats (id, creator_id, snapshot_key)
           SELECT 'clone-chat', 'owner', NULL
           WHERE EXISTS (
             SELECT 1 FROM chat_backup_admissions WHERE id = ? AND owner_id = 'owner' AND status = 'pending'
           )`,
        )
        .bind(extension.admissionId),
      ...extension.suffixStatements,
    ]);
    expect(extension.validateResults(results.slice(0, extension.prefixStatements.length), results.slice(-1))).toBe(
      true,
    );

    await expect(
      admitChatBackupRequest(env, { ownerId: 'owner', chatId: 'upload-chat', now: 10_000 + 60 * 1_000 + 1 }),
    ).rejects.toMatchObject({ kind: 'request-rate', retryAfterSeconds: 24 * 60 * 60 });
  });

  test('keeps expired pending residual capacity charged until reconciliation explicitly releases it', async () => {
    const env = quotaEnv(database, { CHAT_BACKUP_STORAGE_LIMIT_BYTES: '10' });
    let stalled = await admitChatBackupRequest(env, { ownerId: 'owner', chatId: 'stalled', now: 10_000 });
    stalled = await reserveChatBackupBytes(env, stalled, 10, 2, 10_000);
    await registerChatBackupObject(database.db, {
      admission: stalled,
      storageKey: 'message-history/partial',
      sizeBytes: 6,
      kind: 'message-history',
      now: 10_000,
    });
    const afterExpiry = 10_000 + 15 * 60 * 1_000 + 1;
    const next = await admitChatBackupRequest(env, { ownerId: 'owner', chatId: 'next', now: afterExpiry });

    await expect(reserveChatBackupBytes(env, next, 4, 1, afterExpiry)).rejects.toMatchObject({ kind: 'storage' });

    await reconcileChatBackupQuota(
      { DB: database.db, APP_STORAGE: { head: vi.fn() } as unknown as R2Bucket },
      { now: afterExpiry, limit: 1 },
    );
    await expect(reserveChatBackupBytes(env, next, 4, 1, afterExpiry)).resolves.toMatchObject({ reservedBytes: 4 });
    await expect(
      registerChatBackupObject(database.db, {
        admission: stalled,
        storageKey: 'snapshots/late',
        sizeBytes: 4,
        kind: 'snapshot',
        now: afterExpiry,
      }),
    ).rejects.toThrow(/Unable to register/);
  });

  test('releases only the owner attribution whose last reference was removed', async () => {
    database.sqlite.exec(`
      INSERT INTO chat_backup_objects VALUES ('message-history/shared', 7, 'message-history', 'measured', 1);
      INSERT INTO chat_backup_object_attributions VALUES
        ('source-owner', 'message-history/shared', NULL, 1),
        ('clone-owner', 'message-history/shared', NULL, 1);
      INSERT INTO chats (id, creator_id, snapshot_key) VALUES
        ('source-chat', 'source-owner', NULL),
        ('clone-chat', 'clone-owner', NULL);
      INSERT INTO chat_message_states VALUES
        ('source-chat', 'message-history/shared', NULL),
        ('clone-chat', 'message-history/shared', NULL);
      DELETE FROM chat_message_states WHERE chat_id = 'clone-chat';
      UPDATE chats SET is_deleted = 1 WHERE id = 'clone-chat';
    `);

    await expect(releaseUnreferencedChatBackupAttributions(database.db, 'message-history/shared')).resolves.toBe(1);

    expect(
      database.sqlite
        .prepare(`SELECT owner_id FROM chat_backup_object_attributions WHERE storage_key = ?`)
        .all('message-history/shared'),
    ).toEqual([{ owner_id: 'source-owner' }]);
    expect(database.sqlite.prepare(`SELECT COUNT(*) AS count FROM chat_backup_objects`).get()).toEqual({ count: 1 });
  });
});

describe('chat backup quota reconciliation', () => {
  test('keeps migration schema-only so legacy history is discovered in bounded runtime pages', () => {
    const migration = readFileSync(
      new URL('../../../../migrations/0020_chat_backup_quota.sql', import.meta.url),
      'utf8',
    );

    expect(migration).not.toMatch(/FROM\s+(?:chat_message_states|chats|shares)/i);
  });

  test('clamps an oversized caller limit to the global reconciliation budget', async () => {
    const database = new TestD1Database({ backfillReady: false });
    for (let index = 0; index < CHAT_BACKUP_RECONCILIATION_LIMIT + 1; index++) {
      database.sqlite
        .prepare(`INSERT INTO chats (id, creator_id, snapshot_key) VALUES (?, 'owner', NULL)`)
        .run(`chat-${index}`);
      database.sqlite
        .prepare(`INSERT INTO chat_message_states (chat_id, storage_key, snapshot_key) VALUES (?, ?, NULL)`)
        .run(`chat-${index}`, `message-history/${String(index).padStart(3, '0')}`);
    }
    const head = vi.fn().mockResolvedValue({ size: 4 });

    await reconcileChatBackupQuota(
      { DB: database.db, APP_STORAGE: { head } as unknown as R2Bucket },
      { now: 10_000, limit: CHAT_BACKUP_RECONCILIATION_LIMIT * 4 },
    );

    expect(head).toHaveBeenCalledTimes(CHAT_BACKUP_RECONCILIATION_LIMIT);
    expect(database.sqlite.prepare('SELECT COUNT(*) AS count FROM chat_backup_objects').get()).toEqual({
      count: CHAT_BACKUP_RECONCILIATION_LIMIT,
    });
  });

  test('bounds legacy discovery, measures exact R2 bytes, and cleans stale admissions', async () => {
    const database = new TestD1Database({ backfillReady: false });
    for (let index = 0; index < CHAT_BACKUP_RECONCILIATION_LIMIT + 2; index++) {
      database.sqlite
        .prepare(`INSERT INTO chats (id, creator_id, snapshot_key) VALUES (?, 'owner', NULL)`)
        .run(`chat-${index}`);
      database.sqlite
        .prepare(`INSERT INTO chat_message_states (chat_id, storage_key, snapshot_key) VALUES (?, ?, NULL)`)
        .run(`chat-${index}`, `message-history/${String(index).padStart(2, '0')}`);
    }
    database.sqlite
      .prepare(
        `INSERT INTO chat_backup_admissions
         (id, owner_id, chat_id, reserved_bytes, status, created_at, expires_at, completed_at)
         VALUES ('stale', 'owner', 'chat-0', 1, 'pending', 1, 2, NULL),
                ('old', 'owner', 'chat-0', 0, 'completed', 1, 2, 2)`,
      )
      .run();
    let headsInFlight = 0;
    let maximumHeadsInFlight = 0;
    const head = vi.fn(async (key: string) => {
      headsInFlight++;
      maximumHeadsInFlight = Math.max(maximumHeadsInFlight, headsInFlight);
      await Promise.resolve();
      headsInFlight--;
      return key.endsWith('00') ? null : { size: 4 };
    });

    const result = await reconcileChatBackupQuota(
      { DB: database.db, APP_STORAGE: { head } as unknown as R2Bucket },
      { now: 24 * 60 * 60 * 1000 + 10, limit: CHAT_BACKUP_RECONCILIATION_LIMIT },
    );

    expect(result).toEqual({
      releasedReservations: 1,
      purgedAdmissions: 2,
      measuredObjects: CHAT_BACKUP_RECONCILIATION_LIMIT,
      discoveryPasses: 0,
      backfillComplete: false,
    });
    expect(head).toHaveBeenCalledTimes(CHAT_BACKUP_RECONCILIATION_LIMIT);
    expect(maximumHeadsInFlight).toBe(CHAT_BACKUP_HEAD_CONCURRENCY);
    expect(database.sqlite.prepare('SELECT COUNT(*) AS count FROM chat_backup_objects').get()).toEqual({
      count: CHAT_BACKUP_RECONCILIATION_LIMIT,
    });
    expect(
      database.sqlite
        .prepare(`SELECT size_bytes, size_source FROM chat_backup_objects WHERE storage_key = ?`)
        .get('message-history/00'),
    ).toEqual({ size_bytes: 0, size_source: 'measured' });
  });

  test('requires two complete discovery passes and catches a legacy object committed between them', async () => {
    const database = new TestD1Database({ backfillReady: false });
    const env = quotaEnv(database);
    let admission = await admitChatBackupRequest(env, { ownerId: 'owner', chatId: 'chat', now: 10_000 });

    await expect(reserveChatBackupBytes(env, admission, 1, 1, 10_000)).rejects.toMatchObject({ kind: 'not-ready' });
    const storage = { head: vi.fn().mockResolvedValue({ size: 7 }) } as unknown as R2Bucket;
    await reconcileChatBackupQuota({ DB: database.db, APP_STORAGE: storage }, { now: 20_000, limit: 8 });
    expect(
      database.sqlite
        .prepare('SELECT discovery_passes, backfill_completed_at FROM chat_backup_reconciliation_state')
        .get(),
    ).toEqual({ discovery_passes: 1, backfill_completed_at: null });

    database.sqlite.exec(`
      INSERT INTO chats (id, creator_id, snapshot_key) VALUES ('late-chat', 'owner', NULL);
      INSERT INTO chat_message_states VALUES ('late-chat', 'message-history/late', NULL);
    `);
    await reconcileChatBackupQuota({ DB: database.db, APP_STORAGE: storage }, { now: 30_000, limit: 8 });

    expect(
      database.sqlite
        .prepare('SELECT discovery_passes, backfill_completed_at FROM chat_backup_reconciliation_state')
        .get(),
    ).toEqual({ discovery_passes: 2, backfill_completed_at: 30_000 });
    expect(
      database.sqlite
        .prepare(
          `SELECT attributions.owner_id, objects.size_bytes
           FROM chat_backup_object_attributions AS attributions
           JOIN chat_backup_objects AS objects USING (storage_key)
           WHERE storage_key = 'message-history/late'`,
        )
        .get(),
    ).toEqual({ owner_id: 'owner', size_bytes: 7 });
    admission = await admitChatBackupRequest(env, { ownerId: 'owner', chatId: 'chat', now: 40_000 });
    await expect(reserveChatBackupBytes(env, admission, 1, 1, 40_000)).resolves.toMatchObject({ reservedBytes: 1 });
  });

  test('charges a shared physical key independently to every owner that retains it', async () => {
    const database = new TestD1Database({ backfillReady: false });
    database.sqlite.exec(`
      INSERT INTO chats (id, creator_id, snapshot_key)
      VALUES ('source-chat', 'source-owner', NULL), ('clone-chat', 'clone-owner', NULL);
      INSERT INTO shares VALUES ('source-chat', 'message-history/shared', NULL);
      INSERT INTO chat_message_states VALUES ('clone-chat', 'message-history/shared', NULL);
    `);
    const storage = { head: vi.fn().mockResolvedValue({ size: 7 }) } as unknown as R2Bucket;

    await reconcileChatBackupQuota({ DB: database.db, APP_STORAGE: storage }, { now: 10_000, limit: 8 });
    await reconcileChatBackupQuota({ DB: database.db, APP_STORAGE: storage }, { now: 10_001, limit: 8 });
    expect(
      database.sqlite
        .prepare(
          `SELECT owner_id FROM chat_backup_object_attributions
           WHERE storage_key = 'message-history/shared' ORDER BY owner_id`,
        )
        .all(),
    ).toEqual([{ owner_id: 'clone-owner' }, { owner_id: 'source-owner' }]);
    expect(
      database.sqlite
        .prepare(`SELECT COUNT(*) AS count, size_bytes FROM chat_backup_objects WHERE storage_key = ?`)
        .get('message-history/shared'),
    ).toEqual({ count: 1, size_bytes: 7 });
  });

  test('does not skip owners when a shared key crosses a reconciliation page boundary', async () => {
    const database = new TestD1Database({ backfillReady: false });
    database.sqlite.exec(`
      INSERT INTO chats (id, creator_id, snapshot_key)
      VALUES ('chat-a', 'owner-a', NULL), ('chat-b', 'owner-b', NULL);
      INSERT INTO shares VALUES
        ('chat-a', 'message-history/shared', NULL),
        ('chat-b', 'message-history/shared', NULL);
    `);
    const storage = { head: vi.fn().mockResolvedValue({ size: 7 }) } as unknown as R2Bucket;

    for (let pass = 0; pass < 12; pass++) {
      await reconcileChatBackupQuota({ DB: database.db, APP_STORAGE: storage }, { now: 10_000 + pass, limit: 1 });
    }

    expect(
      database.sqlite
        .prepare(
          `SELECT owner_id FROM chat_backup_object_attributions
           WHERE storage_key = 'message-history/shared' ORDER BY owner_id`,
        )
        .all(),
    ).toEqual([{ owner_id: 'owner-a' }, { owner_id: 'owner-b' }]);
  });
});

function quotaEnv(
  database: TestD1Database,
  overrides: ChatBackupQuotaConfig = {},
): Pick<Env, 'DB'> & ChatBackupQuotaConfig {
  return {
    DB: database.db,
    CHAT_BACKUP_STORAGE_QUOTA_MODE: 'enforce',
    CHAT_BACKUP_STORAGE_LIMIT_BYTES: '1073741824',
    CHAT_BACKUP_STORAGE_LIMIT_OBJECTS: '4096',
    CHAT_BACKUP_REQUESTS_PER_MINUTE: '120',
    CHAT_BACKUP_REQUESTS_PER_DAY: '10000',
    ...overrides,
  };
}

class TestD1Database {
  readonly sqlite = new DatabaseSync(':memory:');
  private acknowledgementLossPattern: string | null = null;
  private loseBatchAcknowledgement = false;
  private batchTail: Promise<void> = Promise.resolve();

  constructor(options: { backfillReady?: boolean } = {}) {
    this.sqlite.exec(`
      CREATE TABLE chats (
        id TEXT PRIMARY KEY,
        creator_id TEXT NOT NULL,
        snapshot_key TEXT,
        is_deleted INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE chat_message_states (chat_id TEXT NOT NULL, storage_key TEXT, snapshot_key TEXT);
      CREATE TABLE shares (chat_id TEXT NOT NULL, chat_history_key TEXT, snapshot_key TEXT);
      CREATE INDEX idx_test_states_storage ON chat_message_states(storage_key);
      CREATE INDEX idx_test_states_snapshot ON chat_message_states(snapshot_key);
      CREATE INDEX idx_test_chats_snapshot ON chats(snapshot_key);
      CREATE INDEX idx_test_shares_history ON shares(chat_history_key);
      CREATE INDEX idx_test_shares_snapshot ON shares(snapshot_key);
    `);
    this.sqlite.exec(
      readFileSync(new URL('../../../../migrations/0020_chat_backup_quota.sql', import.meta.url), 'utf8'),
    );
    if (options.backfillReady !== false) {
      this.sqlite.exec(
        `UPDATE chat_backup_reconciliation_state
         SET discovery_passes = 2, last_discovery_completed_at = 1, backfill_completed_at = 1`,
      );
    }
  }

  loseNextAcknowledgementFor(pattern: string): void {
    this.acknowledgementLossPattern = pattern;
  }

  loseNextBatchAcknowledgement(): void {
    this.loseBatchAcknowledgement = true;
  }

  readonly db = {
    prepare: (query: string) => this.prepared(query),
    batch: async (statements: D1PreparedStatement[]) => {
      const previous = this.batchTail;
      let releaseBatch!: () => void;
      this.batchTail = new Promise<void>((resolve) => {
        releaseBatch = resolve;
      });
      await previous;
      try {
        this.sqlite.exec('BEGIN IMMEDIATE');
        let results: D1Result[];
        try {
          results = [];
          for (const statement of statements) {
            results.push(await statement.run());
          }
          this.sqlite.exec('COMMIT');
        } catch (error) {
          this.sqlite.exec('ROLLBACK');
          throw error;
        }
        if (this.loseBatchAcknowledgement) {
          this.loseBatchAcknowledgement = false;
          throw new Error('D1 acknowledgement lost');
        }
        return results;
      } finally {
        releaseBatch();
      }
    },
  } as unknown as D1Database;

  private prepared(query: string): D1PreparedStatement {
    const execute = (values: unknown[]) => {
      const statement = this.sqlite.prepare(query);
      return {
        run: async () => {
          const result = statement.run(...(values as SQLInputValue[]));
          if (this.acknowledgementLossPattern && query.includes(this.acknowledgementLossPattern)) {
            this.acknowledgementLossPattern = null;
            throw new Error('D1 acknowledgement lost');
          }
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

test('quota errors retain stable classifications', () => {
  expect(new ChatBackupQuotaError('storage')).toMatchObject({ kind: 'storage' });
});
