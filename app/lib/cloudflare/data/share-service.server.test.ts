import { beforeEach, describe, expect, test, vi } from 'vitest';
import { getLatestStorageState, insertChatWithState, requireChat } from './chat-repository.server';
import {
  cancelObjectGcCandidate,
  prepareObjectGcCandidateStatements,
  queueObjectGcCandidate,
  sweepObjectGcCandidatesBestEffort,
} from './object-gc.server';
import { allocateObjectKey, putObjectAtKey } from './object-storage.server';
import {
  cloneShare,
  createShare,
  getShareDescription,
  getSocialShare,
  saveThumbnail,
  upsertSocialShare,
} from './share-service.server';
import type { SocialShareRow } from './types';
import {
  createChatBackupCloneQuotaExtension,
  enforceChatBackupEdgeRateLimit,
  releaseChatBackupCloneAdmissionBestEffort,
  throwIfChatBackupCloneQuotaDenied,
} from './chat-backup-quota.server';

vi.mock('./chat-repository.server', () => ({
  getLatestStorageState: vi.fn(),
  insertChatWithState: vi.fn(),
  requireChat: vi.fn(),
}));
vi.mock('./object-storage.server', () => ({
  allocateObjectKey: vi.fn(),
  putObjectAtKey: vi.fn(),
  storageUrl: vi.fn((key: string) => `/api/storage/${encodeURIComponent(key)}`),
}));
vi.mock('./object-gc.server', () => ({
  cancelObjectGcCandidate: vi.fn(),
  prepareObjectGcCandidateStatements: vi.fn(() => []),
  queueObjectGcCandidate: vi.fn(),
  sweepObjectGcCandidatesBestEffort: vi.fn(),
}));
vi.mock('./chat-backup-quota.server', () => ({
  createChatBackupCloneQuotaExtension: vi.fn(() => ({
    admissionId: 'clone-admission',
    prefixStatements: [],
    suffixStatements: [],
    validateResults: vi.fn(() => true),
    verifyReceipt: vi.fn().mockResolvedValue(true),
  })),
  enforceChatBackupEdgeRateLimit: vi.fn().mockResolvedValue(undefined),
  releaseChatBackupCloneAdmissionBestEffort: vi.fn().mockResolvedValue(undefined),
  throwIfChatBackupCloneQuotaDenied: vi.fn().mockResolvedValue(undefined),
}));

const requireChatMock = vi.mocked(requireChat);
const getLatestStorageStateMock = vi.mocked(getLatestStorageState);
const insertChatWithStateMock = vi.mocked(insertChatWithState);
const allocateObjectKeyMock = vi.mocked(allocateObjectKey);
const prepareObjectGcCandidateStatementsMock = vi.mocked(prepareObjectGcCandidateStatements);
const queueObjectGcCandidateMock = vi.mocked(queueObjectGcCandidate);
const cancelObjectGcCandidateMock = vi.mocked(cancelObjectGcCandidate);
const sweepObjectGcCandidatesBestEffortMock = vi.mocked(sweepObjectGcCandidatesBestEffort);
const putObjectAtKeyMock = vi.mocked(putObjectAtKey);
const createChatBackupCloneQuotaExtensionMock = vi.mocked(createChatBackupCloneQuotaExtension);
const enforceChatBackupEdgeRateLimitMock = vi.mocked(enforceChatBackupEdgeRateLimit);
const releaseChatBackupCloneAdmissionBestEffortMock = vi.mocked(releaseChatBackupCloneAdmissionBestEffort);
const throwIfChatBackupCloneQuotaDeniedMock = vi.mocked(throwIfChatBackupCloneQuotaDenied);
const STRONG_SHARE_CODE = 'a'.repeat(32);

describe('thumbnail object ownership', () => {
  beforeEach(() => {
    requireChatMock.mockReset();
    allocateObjectKeyMock.mockReset().mockReturnValue('thumbnails/new');
    putObjectAtKeyMock.mockReset().mockResolvedValue(undefined);
    queueObjectGcCandidateMock
      .mockReset()
      .mockImplementation(async (_db, storageKey) => ({ storageKey, notBefore: 123 }));
    cancelObjectGcCandidateMock.mockReset().mockResolvedValue(true);
    prepareObjectGcCandidateStatementsMock.mockClear();
    sweepObjectGcCandidatesBestEffortMock.mockReset();
    requireChatMock.mockResolvedValue({ id: 'chat-row' } as Awaited<ReturnType<typeof requireChat>>);
  });

  test('queues the previous thumbnail after a compare-and-swap replacement', async () => {
    const database = new SocialShareDatabase(socialShare({ thumbnail_image_key: 'thumbnail-old' }));
    const env = thumbnailEnv(database);

    await expect(
      saveThumbnail(env, {
        sessionId: 'session',
        chatId: 'chat',
        image: new Blob(['image'], { type: 'image/png' }),
      }),
    ).resolves.toBe('thumbnails/new');

    expect(database.state?.thumbnail_image_key).toBe('thumbnails/new');
    expect(queueObjectGcCandidateMock).toHaveBeenCalledWith(database.db, 'thumbnails/new');
    expect(cancelObjectGcCandidateMock).toHaveBeenCalledWith(database.db, {
      storageKey: 'thumbnails/new',
      notBefore: 123,
    });
    expect(prepareObjectGcCandidateStatementsMock).toHaveBeenCalledWith(database.db, ['thumbnail-old']);
    expect(sweepObjectGcCandidatesBestEffortMock).toHaveBeenCalledWith(env);
  });

  test('leaves the never-published thumbnail on its durable cleanup receipt when the database write fails', async () => {
    const database = new SocialShareDatabase(socialShare({ thumbnail_image_key: 'thumbnail-old' }));
    database.writeError = new Error('database unavailable');
    const env = thumbnailEnv(database);

    await expect(
      saveThumbnail(env, {
        sessionId: 'session',
        chatId: 'chat',
        image: new Blob(['image'], { type: 'image/png' }),
      }),
    ).rejects.toThrow('database unavailable');

    expect(queueObjectGcCandidateMock).toHaveBeenCalledWith(database.db, 'thumbnails/new');
    expect(cancelObjectGcCandidateMock).not.toHaveBeenCalled();
  });

  test('preserves a live thumbnail and its receipt when D1 commits before losing its acknowledgement', async () => {
    const database = new SocialShareDatabase(socialShare({ thumbnail_image_key: 'thumbnail-old' }));
    database.throwAfterNextThumbnailCommit = true;
    const env = thumbnailEnv(database);

    await expect(
      saveThumbnail(env, {
        sessionId: 'session',
        chatId: 'chat',
        image: new Blob(['image'], { type: 'image/png' }),
      }),
    ).rejects.toThrow('D1 acknowledgement lost');

    expect(database.state?.thumbnail_image_key).toBe('thumbnails/new');
    expect(queueObjectGcCandidateMock).toHaveBeenCalledWith(database.db, 'thumbnails/new');
    expect(cancelObjectGcCandidateMock).not.toHaveBeenCalled();
  });

  test('queues the thumbnail before an R2 commit loses its acknowledgement', async () => {
    const database = new SocialShareDatabase(socialShare({ thumbnail_image_key: 'thumbnail-old' }));
    const env = thumbnailEnv(database);
    const committedObjects = new Set<string>();
    putObjectAtKeyMock.mockImplementationOnce(async (_env, key) => {
      committedObjects.add(key);
      throw new Error('R2 acknowledgement lost');
    });

    await expect(
      saveThumbnail(env, {
        sessionId: 'session',
        chatId: 'chat',
        image: new Blob(['image'], { type: 'image/png' }),
      }),
    ).rejects.toThrow('R2 acknowledgement lost');

    expect(committedObjects).toEqual(new Set(['thumbnails/new']));
    expect(queueObjectGcCandidateMock.mock.invocationCallOrder[0]).toBeLessThan(
      putObjectAtKeyMock.mock.invocationCallOrder[0],
    );
    expect(database.state?.thumbnail_image_key).toBe('thumbnail-old');
    expect(cancelObjectGcCandidateMock).not.toHaveBeenCalled();
  });

  test('retries a stale compare-and-swap and queues each displaced candidate', async () => {
    const database = new SocialShareDatabase(socialShare({ thumbnail_image_key: 'thumbnail-old' }));
    database.failFirstCasAsStale = true;
    const env = thumbnailEnv(database);

    await expect(
      saveThumbnail(env, {
        sessionId: 'session',
        chatId: 'chat',
        image: new Blob(['image'], { type: 'image/png' }),
      }),
    ).resolves.toBe('thumbnails/new');

    expect(database.state?.thumbnail_image_key).toBe('thumbnails/new');
    expect(prepareObjectGcCandidateStatementsMock.mock.calls.map(([, keys]) => keys)).toEqual([
      ['thumbnail-old'],
      ['thumbnail-concurrent'],
    ]);
  });
});

describe('social share concurrency', () => {
  beforeEach(() => {
    requireChatMock.mockReset();
    requireChatMock.mockResolvedValue({ id: 'chat-row' } as Awaited<ReturnType<typeof requireChat>>);
  });

  test('uses chat uniqueness while rotating across concurrent sharing-state transitions', async () => {
    const database = new SocialShareDatabase(null);

    const codes = await Promise.all([
      upsertSocialShare(database.db, { sessionId: 'session', id: 'chat', isShared: true }),
      upsertSocialShare(database.db, { sessionId: 'session', id: 'chat', isShared: false }),
    ]);

    expect(database.insertedRows).toBe(1);
    expect(database.state?.code).toMatch(/^[a-f0-9]{32}$/);
    expect(codes).toContain(database.state!.code);
  });

  test('never resurrects a capability after revocation and re-enable', async () => {
    const originalCode = 'b'.repeat(32);
    const database = new SocialShareDatabase(socialShare({ code: originalCode, is_shared: 1 }));

    const revokedCode = await upsertSocialShare(database.db, {
      sessionId: 'session',
      id: 'chat',
      isShared: false,
    });
    expect(database.state?.is_shared).toBe(0);
    expect(revokedCode).not.toBe(originalCode);

    const reenabledCode = await upsertSocialShare(database.db, {
      sessionId: 'session',
      id: 'chat',
      isShared: true,
    });
    expect(database.state?.is_shared).toBe(1);
    expect(reenabledCode).not.toBe(originalCode);
    expect(reenabledCode).not.toBe(revokedCode);

    await expect(upsertSocialShare(database.db, { sessionId: 'session', id: 'chat', isShared: true })).resolves.toBe(
      reenabledCode,
    );
  });

  test('keeps the pre-race capability invalid after concurrent disable and enable', async () => {
    const originalCode = 'c'.repeat(32);
    const database = new SocialShareDatabase(socialShare({ code: originalCode, is_shared: 1 }));

    await Promise.all([
      upsertSocialShare(database.db, { sessionId: 'session', id: 'chat', isShared: false }),
      upsertSocialShare(database.db, { sessionId: 'session', id: 'chat', isShared: true }),
    ]);
    const finalCode = await upsertSocialShare(database.db, {
      sessionId: 'session',
      id: 'chat',
      isShared: true,
    });

    expect(database.state?.is_shared).toBe(1);
    expect(finalCode).toBe(database.state?.code);
    expect(finalCode).not.toBe(originalCode);
  });

  test('does not recreate a social-share reference after chat deletion wins the race', async () => {
    const database = new SocialShareDatabase(null);
    database.chatDeleted = true;

    await expect(upsertSocialShare(database.db, { sessionId: 'session', id: 'chat', isShared: true })).rejects.toThrow(
      'Chat not found',
    );
    expect(database.state).toBeNull();
  });
});

describe('share persistence', () => {
  beforeEach(() => {
    requireChatMock.mockReset();
    getLatestStorageStateMock.mockReset();
    insertChatWithStateMock.mockReset();
    enforceChatBackupEdgeRateLimitMock.mockReset().mockResolvedValue(undefined);
    createChatBackupCloneQuotaExtensionMock.mockClear();
    releaseChatBackupCloneAdmissionBestEffortMock.mockClear();
    throwIfChatBackupCloneQuotaDeniedMock.mockClear();
  });

  test('rejects sharing a fresh empty subchat even when it inherited a snapshot', async () => {
    requireChatMock.mockResolvedValue({
      id: 'chat-row',
      last_subchat_index: 1,
      snapshot_key: 'snapshot-old',
    } as Awaited<ReturnType<typeof requireChat>>);
    getLatestStorageStateMock.mockResolvedValue({
      storage_key: null,
      snapshot_key: 'snapshot-old',
    } as Awaited<ReturnType<typeof getLatestStorageState>>);

    await expect(createShare({} as D1Database, { sessionId: 'session', id: 'chat' })).rejects.toThrow(
      'Chat history not found',
    );
  });

  test('returns the intended capability when its exact row commits before D1 loses its acknowledgement', async () => {
    requireChatMock.mockResolvedValue({
      id: 'chat-row',
      creator_id: 'session',
      description: 'Shared app',
      last_subchat_index: 2,
      snapshot_key: 'chat-snapshot',
    } as Awaited<ReturnType<typeof requireChat>>);
    getLatestStorageStateMock.mockResolvedValue({
      storage_key: 'history-key',
      snapshot_key: 'state-snapshot',
      last_message_rank: 4,
      part_index: 1,
    } as Awaited<ReturnType<typeof getLatestStorageState>>);
    const database = new LegacyShareWriteDatabase();

    await expect(createShare(database.db, { sessionId: 'session', id: 'chat' })).resolves.toEqual({
      code: expect.stringMatching(/^[a-f0-9]{32}$/),
    });

    expect(database.committedValues).not.toBeNull();
    expect(database.receiptQuery).toContain('shares.id = ?');
    expect(database.receiptQuery).toContain('shares.code = ?');
    expect(database.receiptQuery).toContain('chats.creator_id = ?');
    expect(database.receiptValues).toEqual(
      expect.arrayContaining(['chat-row', 'session', 'history-key', 'state-snapshot', 'Shared app']),
    );
  });

  test('preserves the share insert failure when the commit receipt does not match exactly', async () => {
    requireChatMock.mockResolvedValue({
      id: 'chat-row',
      creator_id: 'session',
      description: 'Shared app',
      last_subchat_index: 2,
      snapshot_key: 'chat-snapshot',
    } as Awaited<ReturnType<typeof requireChat>>);
    getLatestStorageStateMock.mockResolvedValue({
      storage_key: 'history-key',
      snapshot_key: 'state-snapshot',
      last_message_rank: 4,
      part_index: 1,
    } as Awaited<ReturnType<typeof getLatestStorageState>>);
    const database = new LegacyShareWriteDatabase(false);

    await expect(createShare(database.db, { sessionId: 'session', id: 'chat' })).rejects.toThrow(
      'D1 acknowledgement lost',
    );
  });

  test('uses one atomic chat-and-state batch when cloning and surfaces batch failure', async () => {
    const share = legacyShare({ chat_history_key: 'history-key' });
    const db = shareLookupDb(share);
    insertChatWithStateMock.mockRejectedValue(new Error('atomic batch failed'));

    await expect(cloneShare(cloneEnv(db), { shareCode: STRONG_SHARE_CODE, sessionId: 'session' })).rejects.toThrow(
      'atomic batch failed',
    );
    expect(insertChatWithStateMock).toHaveBeenCalledOnce();
    expect(insertChatWithStateMock).toHaveBeenCalledWith(
      db,
      expect.any(Object),
      expect.any(Object),
      {
        kind: 'legacy-share',
        code: STRONG_SHARE_CODE,
        parentChatId: 'parent-chat',
        quotaAdmissionId: 'clone-admission',
      },
      expect.objectContaining({ admissionId: 'clone-admission' }),
    );
    expect(releaseChatBackupCloneAdmissionBestEffortMock).toHaveBeenCalledOnce();
  });

  test('applies edge shedding before the first share lookup', async () => {
    const prepare = vi.fn();
    const edgeDenial = new Error('edge rate denied');
    enforceChatBackupEdgeRateLimitMock.mockRejectedValueOnce(edgeDenial);

    await expect(
      cloneShare(cloneEnv({ prepare } as unknown as D1Database), {
        shareCode: STRONG_SHARE_CODE,
        sessionId: 'session',
      }),
    ).rejects.toBe(edgeDenial);

    expect(enforceChatBackupEdgeRateLimitMock).toHaveBeenCalledWith(expect.any(Object), 'session');
    expect(prepare).not.toHaveBeenCalled();
  });

  test('rejects a legacy share without stored chat history', async () => {
    const db = shareLookupDb(legacyShare({ chat_history_key: null }));

    await expect(cloneShare(cloneEnv(db), { shareCode: STRONG_SHARE_CODE, sessionId: 'session' })).rejects.toThrow(
      'Chat history not found',
    );
    expect(insertChatWithStateMock).not.toHaveBeenCalled();
  });

  test('clones only an active social share and keeps its selected subchat snapshot', async () => {
    const db = socialShareLookupDb({
      ...socialShare(),
      chat_description: 'Shared app',
      chat_last_subchat_index: 2,
      chat_snapshot_key: 'chat-snapshot',
    });
    getLatestStorageStateMock.mockResolvedValue({
      storage_key: 'history-key',
      snapshot_key: null,
      subchat_index: 2,
      last_message_rank: 4,
      part_index: 1,
      description: 'Shared app',
    } as Awaited<ReturnType<typeof getLatestStorageState>>);

    await cloneShare(cloneEnv(db), { shareCode: STRONG_SHARE_CODE, sessionId: 'session' });

    expect(getLatestStorageStateMock).toHaveBeenCalledWith(db, { chatId: 'chat-row', subchatIndex: 2 });
    expect(insertChatWithStateMock).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ description: 'Shared app', snapshotKey: 'chat-snapshot' }),
      expect.objectContaining({ storageKey: 'history-key', subchatIndex: 2, snapshotKey: 'chat-snapshot' }),
      {
        kind: 'social-share',
        code: STRONG_SHARE_CODE,
        parentChatId: 'chat-row',
        quotaAdmissionId: 'clone-admission',
      },
      expect.objectContaining({ admissionId: 'clone-admission' }),
    );
  });

  test('rejects pre-fix short share capabilities without querying saved state', async () => {
    const prepare = vi.fn();
    const db = { prepare } as unknown as D1Database;

    await expect(getShareDescription(db, { code: 'abc123' })).rejects.toThrow('Invalid share link');
    await expect(cloneShare(cloneEnv(db), { shareCode: 'abc123', sessionId: 'session' })).rejects.toThrow(
      'Invalid share link',
    );
    expect(prepare).not.toHaveBeenCalled();
  });

  test('requires an undeleted parent for legacy share reads and clones', async () => {
    let queries = '';
    const db = {
      prepare: vi.fn((query: string) => {
        queries += query;
        return { bind: vi.fn(() => ({ first: vi.fn().mockResolvedValue(null) })) };
      }),
    } as unknown as D1Database;

    await expect(getShareDescription(db, { code: STRONG_SHARE_CODE })).rejects.toThrow('Invalid share link');
    await expect(cloneShare(cloneEnv(db), { shareCode: STRONG_SHARE_CODE, sessionId: 'session' })).rejects.toThrow(
      'Invalid share link',
    );
    expect(queries).toContain('JOIN chats ON chats.id = shares.chat_id');
    expect(queries).toContain('chats.is_deleted = 0');
  });
});

describe('public social shares', () => {
  test('requires the share and its chat to remain active', async () => {
    let query = '';
    const env = {
      DB: {
        prepare(sql: string) {
          query = sql;
          return {
            bind: () => ({
              first: async () => ({
                ...socialShare({ thumbnail_image_key: 'thumbnail-key' }),
                chat_description: 'Shared app',
              }),
            }),
          };
        },
      },
    } as unknown as Env;

    await expect(getSocialShare(env, STRONG_SHARE_CODE)).resolves.toEqual({
      code: STRONG_SHARE_CODE,
      description: 'Shared app',
      thumbnailUrl: '/api/storage/thumbnail-key',
    });
    expect(query).toContain('social_shares.is_shared = 1');
    expect(query).toContain('chats.is_deleted = 0');
  });
});

class SocialShareDatabase {
  state: SocialShareRow | null;
  insertedRows = 0;
  writeError: Error | null = null;
  throwAfterNextThumbnailCommit = false;
  failFirstCasAsStale = false;
  chatDeleted = false;

  constructor(state: SocialShareRow | null) {
    this.state = state;
  }

  readonly db = {
    prepare: (query: string) => ({
      bind: (...values: unknown[]) => new FakeStatement(this, query, values),
    }),
    batch: async (statements: FakeStatement[]) => {
      const results = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      return results;
    },
  } as unknown as D1Database;

  async first(query: string, values: unknown[]): Promise<unknown> {
    if (query.includes('SELECT 1 AS found FROM shares')) {
      return null;
    }
    if (query.includes('INSERT INTO social_shares')) {
      if (this.chatDeleted) {
        return null;
      }
      if (!this.state) {
        this.state = {
          id: values[0] as string,
          chat_id: values[1] as string,
          code: values[2] as string,
          thumbnail_image_key: null,
          is_shared: values[3] as number,
        };
        this.insertedRows++;
      } else {
        const sharingChanged = this.state.is_shared !== (values[3] as number);
        if (!/^[a-f0-9]{32}$/.test(this.state.code) || (values[5] && sharingChanged)) {
          this.state.code = values[2] as string;
        }
        if (values[6]) {
          this.state.is_shared = values[3] as number;
        }
      }
      if (!/^[a-f0-9]{32}$/.test(this.state.code)) {
        this.state.code = values[2] as string;
      }
      return { ...this.state };
    }
    if (query.includes('SELECT * FROM social_shares WHERE chat_id')) {
      return this.state ? { ...this.state } : null;
    }
    return null;
  }

  async run(query: string, values: unknown[]) {
    if (query.includes('UPDATE social_shares')) {
      if (this.writeError) {
        throw this.writeError;
      }
      if (this.failFirstCasAsStale) {
        this.failFirstCasAsStale = false;
        if (this.state) {
          this.state.thumbnail_image_key = 'thumbnail-concurrent';
        }
        return changed(0);
      }
      const current = this.state;
      if (!current) {
        return changed(0);
      }
      if (current.id === values[1] && current.thumbnail_image_key === values[2]) {
        current.thumbnail_image_key = values[0] as string;
        if (this.throwAfterNextThumbnailCommit) {
          this.throwAfterNextThumbnailCommit = false;
          throw new Error('D1 acknowledgement lost');
        }
        return changed(1);
      }
      return changed(0);
    }
    return changed(1);
  }
}

class FakeStatement {
  constructor(
    private readonly database: SocialShareDatabase,
    private readonly query: string,
    private readonly values: unknown[],
  ) {}

  first<T>(): Promise<T | null> {
    return this.database.first(this.query, this.values) as Promise<T | null>;
  }

  run() {
    return this.database.run(this.query, this.values);
  }
}

class LegacyShareWriteDatabase {
  committedValues: unknown[] | null = null;
  receiptQuery = '';
  receiptValues: unknown[] = [];

  constructor(private readonly receiptMatches = true) {}

  readonly db = {
    prepare: (query: string) => ({
      bind: (...values: unknown[]) => ({
        first: async () => {
          if (query.includes('SELECT 1 AS found FROM shares')) {
            return null;
          }
          if (query.includes('SELECT 1 AS found')) {
            this.receiptQuery = query;
            this.receiptValues = values;
            const expected = this.committedValues
              ? [
                  this.committedValues[0],
                  this.committedValues[1],
                  this.committedValues[3],
                  this.committedValues[2],
                  this.committedValues[4],
                  this.committedValues[5],
                  this.committedValues[6],
                  this.committedValues[7],
                  this.committedValues[8],
                  this.committedValues[10],
                ]
              : null;
            return this.receiptMatches && JSON.stringify(values) === JSON.stringify(expected) ? { found: 1 } : null;
          }
          return null;
        },
        run: async () => {
          if (query.includes('INSERT INTO shares')) {
            this.committedValues = values;
            throw new Error('D1 acknowledgement lost');
          }
          return changed(0);
        },
      }),
    }),
  } as unknown as D1Database;
}

function socialShare(overrides: Partial<SocialShareRow> = {}): SocialShareRow {
  return {
    id: 'share-row',
    chat_id: 'chat-row',
    code: STRONG_SHARE_CODE,
    thumbnail_image_key: null,
    is_shared: 1,
    ...overrides,
  };
}

function thumbnailEnv(database: SocialShareDatabase) {
  return { DB: database.db, APP_STORAGE: {} } as unknown as Env;
}

function cloneEnv(db: D1Database) {
  return {
    DB: db,
    CHAT_BACKUP_RATE_LIMITER: { limit: vi.fn() } as unknown as RateLimit,
    CHAT_BACKUP_STORAGE_QUOTA_MODE: 'enforce' as const,
    CHAT_BACKUP_STORAGE_LIMIT_BYTES: '1073741824',
    CHAT_BACKUP_STORAGE_LIMIT_OBJECTS: '4096',
  };
}

function legacyShare(overrides: Record<string, unknown>) {
  return {
    id: 'share-row',
    chat_id: 'parent-chat',
    snapshot_key: 'snapshot-key',
    code: STRONG_SHARE_CODE,
    last_message_rank: 4,
    last_subchat_index: 0,
    part_index: 1,
    description: 'Shared app',
    parent_description: 'Shared app',
    ...overrides,
  };
}

function shareLookupDb(share: object): D1Database {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({ first: vi.fn().mockResolvedValue(share) })),
    })),
  } as unknown as D1Database;
}

function socialShareLookupDb(share: object): D1Database {
  return {
    prepare: vi.fn((query: string) => ({
      bind: vi.fn(() => ({
        first: vi.fn().mockResolvedValue(query.includes('FROM shares') ? null : share),
      })),
    })),
  } as unknown as D1Database;
}

function changed(changes: number) {
  return { success: true, meta: { changes } };
}
