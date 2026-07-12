import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  getLatestStorageState,
  insertChatWithState,
  requireChat,
  requireChatByPrimaryId,
} from './chat-repository.server';
import { prepareObjectGcCandidateStatements, sweepObjectGcCandidatesBestEffort } from './object-gc.server';
import { deleteObject, putObject } from './object-storage.server';
import { cloneShare, createShare, saveThumbnail, upsertSocialShare } from './share-service.server';
import type { SocialShareRow } from './types';

vi.mock('./chat-repository.server', () => ({
  getLatestStorageState: vi.fn(),
  insertChatWithState: vi.fn(),
  requireChat: vi.fn(),
  requireChatByPrimaryId: vi.fn(),
}));
vi.mock('./object-storage.server', () => ({
  putObject: vi.fn(),
  deleteObject: vi.fn(),
  storageUrl: vi.fn((key: string) => `/api/storage/${encodeURIComponent(key)}`),
}));
vi.mock('./object-gc.server', () => ({
  prepareObjectGcCandidateStatements: vi.fn(() => []),
  sweepObjectGcCandidatesBestEffort: vi.fn(),
}));

const requireChatMock = vi.mocked(requireChat);
const requireChatByPrimaryIdMock = vi.mocked(requireChatByPrimaryId);
const getLatestStorageStateMock = vi.mocked(getLatestStorageState);
const insertChatWithStateMock = vi.mocked(insertChatWithState);
const prepareObjectGcCandidateStatementsMock = vi.mocked(prepareObjectGcCandidateStatements);
const sweepObjectGcCandidatesBestEffortMock = vi.mocked(sweepObjectGcCandidatesBestEffort);
const putObjectMock = vi.mocked(putObject);
const deleteObjectMock = vi.mocked(deleteObject);

describe('thumbnail object ownership', () => {
  beforeEach(() => {
    requireChatMock.mockReset();
    putObjectMock.mockReset();
    deleteObjectMock.mockReset();
    prepareObjectGcCandidateStatementsMock.mockClear();
    sweepObjectGcCandidatesBestEffortMock.mockReset();
    requireChatMock.mockResolvedValue({ id: 'chat-row' } as Awaited<ReturnType<typeof requireChat>>);
    putObjectMock.mockResolvedValue('thumbnail-new');
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
    ).resolves.toBe('thumbnail-new');

    expect(database.state?.thumbnail_image_key).toBe('thumbnail-new');
    expect(deleteObjectMock).not.toHaveBeenCalledWith(env, 'thumbnail-old');
    expect(prepareObjectGcCandidateStatementsMock).toHaveBeenCalledWith(database.db, ['thumbnail-old']);
    expect(sweepObjectGcCandidatesBestEffortMock).toHaveBeenCalledWith(env);
  });

  test('deletes the never-published thumbnail when the database write fails', async () => {
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

    expect(deleteObjectMock).toHaveBeenCalledWith(env, 'thumbnail-new');
    expect(deleteObjectMock).not.toHaveBeenCalledWith(env, 'thumbnail-old');
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
    ).resolves.toBe('thumbnail-new');

    expect(database.state?.thumbnail_image_key).toBe('thumbnail-new');
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

  test('uses chat uniqueness so concurrent upserts return one durable code', async () => {
    const database = new SocialShareDatabase(null);

    const codes = await Promise.all([
      upsertSocialShare(database.db, { sessionId: 'session', id: 'chat', isShared: true }),
      upsertSocialShare(database.db, { sessionId: 'session', id: 'chat', isShared: false }),
    ]);

    expect(new Set(codes)).toEqual(new Set([database.state?.code]));
    expect(database.insertedRows).toBe(1);
  });
});

describe('share persistence', () => {
  beforeEach(() => {
    requireChatMock.mockReset();
    requireChatByPrimaryIdMock.mockReset();
    getLatestStorageStateMock.mockReset();
    insertChatWithStateMock.mockReset();
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

  test('uses one atomic chat-and-state batch when cloning and surfaces batch failure', async () => {
    const share = legacyShare({ chat_history_key: 'history-key' });
    const db = shareLookupDb(share);
    requireChatByPrimaryIdMock.mockResolvedValue({ description: 'Shared app' } as Awaited<
      ReturnType<typeof requireChatByPrimaryId>
    >);
    insertChatWithStateMock.mockRejectedValue(new Error('atomic batch failed'));

    await expect(cloneShare(db, { shareCode: 'share-code', sessionId: 'session' })).rejects.toThrow(
      'atomic batch failed',
    );
    expect(insertChatWithStateMock).toHaveBeenCalledOnce();
  });

  test('rejects a legacy share without stored chat history', async () => {
    const db = shareLookupDb(legacyShare({ chat_history_key: null }));

    await expect(cloneShare(db, { shareCode: 'share-code', sessionId: 'session' })).rejects.toThrow(
      'Chat history not found',
    );
    expect(requireChatByPrimaryIdMock).not.toHaveBeenCalled();
    expect(insertChatWithStateMock).not.toHaveBeenCalled();
  });
});

class SocialShareDatabase {
  state: SocialShareRow | null;
  insertedRows = 0;
  writeError: Error | null = null;
  failFirstCasAsStale = false;

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
      if (!this.state) {
        this.state = {
          id: values[0] as string,
          chat_id: values[1] as string,
          code: values[2] as string,
          thumbnail_image_key: null,
          is_shared: values[3] as number,
        };
        this.insertedRows++;
      } else if (values[4]) {
        this.state.is_shared = values[3] as number;
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

function socialShare(overrides: Partial<SocialShareRow> = {}): SocialShareRow {
  return {
    id: 'share-row',
    chat_id: 'chat-row',
    code: 'share-code',
    thumbnail_image_key: null,
    is_shared: 1,
    ...overrides,
  };
}

function thumbnailEnv(database: SocialShareDatabase) {
  return { DB: database.db, APP_STORAGE: {} } as unknown as Env;
}

function legacyShare(overrides: Record<string, unknown>) {
  return {
    id: 'share-row',
    chat_id: 'parent-chat',
    snapshot_key: 'snapshot-key',
    code: 'share-code',
    last_message_rank: 4,
    last_subchat_index: 0,
    part_index: 1,
    description: 'Shared app',
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

function changed(changes: number) {
  return { success: true, meta: { changes } };
}
