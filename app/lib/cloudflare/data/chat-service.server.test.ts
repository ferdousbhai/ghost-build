import { describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
  createSubchat,
  discardEmptyChat,
  getAllChats,
  getSubchats,
  removeChat,
  setGeneratedDescriptionIfMissing,
  setGeneratedSubchatDescription,
  setSubchatDescription,
} from './chat-service.server';
import type { ChatRow, ChatTranscriptRow } from './types';
import { AGENT_GC_GRACE_PERIOD_MS } from './agent-gc.server';

describe('setGeneratedDescriptionIfMissing', () => {
  it('sets a generated title only through an owner-scoped conditional update', async () => {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
    const bind = vi.fn(() => ({ run }));
    const prepare = vi.fn(() => ({ bind }));

    await expect(
      setGeneratedDescriptionIfMissing({ prepare } as unknown as D1Database, {
        sessionId: 'user-1',
        id: 'chat-1',
        description: 'Cloudflare Verification App',
      }),
    ).resolves.toBe(true);

    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("NULLIF(TRIM(description), '') IS NULL"));
    expect(bind).toHaveBeenCalledWith('Cloudflare Verification App', 'user-1', 'chat-1', 'chat-1');
  });

  it('does not overwrite a title that already exists', async () => {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 0 } });
    const db = {
      prepare: vi.fn(() => ({ bind: vi.fn(() => ({ run })) })),
    } as unknown as D1Database;

    await expect(
      setGeneratedDescriptionIfMissing(db, {
        sessionId: 'user-1',
        id: 'chat-1',
        description: 'Generated title',
      }),
    ).resolves.toBe(false);
  });
});

describe('setGeneratedSubchatDescription', () => {
  it('replaces the current transcript generation label through an owner-scoped update', async () => {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
    const bind = vi.fn(() => ({ run }));
    const prepare = vi.fn(() => ({ bind }));

    await expect(
      setGeneratedSubchatDescription({ prepare } as unknown as D1Database, {
        sessionId: 'user-1',
        id: 'chat-1',
        subchatIndex: 2,
        description: 'Pocket Poll',
        provisionalDescription: 'polling app',
      }),
    ).resolves.toBe(true);

    expect(prepare).toHaveBeenCalledWith(expect.stringContaining('SET description = ?'));
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining('UPDATE chat_transcripts'));
    expect(bind).toHaveBeenCalledWith('Pocket Poll', 'user-1', 'chat-1', 'chat-1', 2, 'polling app');
  });

  it('does not replace a manual title that raced the generated title', async () => {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 0 } });
    const db = {
      prepare: vi.fn(() => ({ bind: vi.fn(() => ({ run })) })),
    } as unknown as D1Database;

    await expect(
      setGeneratedSubchatDescription(db, {
        sessionId: 'user-1',
        id: 'chat-1',
        subchatIndex: 0,
        description: 'Generated title',
        provisionalDescription: 'provisional title',
      }),
    ).resolves.toBe(false);
  });
});

describe('setSubchatDescription', () => {
  it('lets the owner overwrite the current chat title', async () => {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
    const bind = vi.fn(() => ({ run }));
    const prepare = vi.fn(() => ({ bind }));

    await expect(
      setSubchatDescription({ prepare } as unknown as D1Database, {
        sessionId: 'user-1',
        chatId: 'chat-1',
        subchatIndex: 0,
        description: 'My custom title',
      }),
    ).resolves.toBeNull();

    expect(bind).toHaveBeenCalledWith('My custom title', 'user-1', 'chat-1', 'chat-1', 0);
  });
});

describe('empty chat lifecycle', () => {
  it('keeps drafts without persisted messages out of project history', async () => {
    const all = vi.fn().mockResolvedValue({ results: [] });
    const bind = vi.fn(() => ({ all }));
    const prepare = vi.fn(() => ({ bind }));

    await expect(getAllChats({ prepare } as unknown as D1Database, { sessionId: 'user-1' })).resolves.toEqual({
      items: [],
      nextCursor: undefined,
    });

    expect(prepare).toHaveBeenCalledWith(expect.stringContaining('chat_transcripts.head_revision > 0'));
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining('LIMIT ?'));
    expect(bind).toHaveBeenCalledWith('user-1', 51);
  });

  it('discards only an owner-scoped chat that is still empty', async () => {
    const statements: Array<{ query: string; values: unknown[] }> = [];
    const prepare = vi.fn((query: string) => ({
      bind: vi.fn((...values: unknown[]) => ({ query, values })),
    }));
    const batch = vi.fn(async (items: Array<{ query: string; values: unknown[] }>) => {
      statements.push(...items);
      return [];
    });

    await expect(
      discardEmptyChat({ prepare, batch } as unknown as D1Database, { sessionId: 'user-1', id: 'chat-1' }),
    ).resolves.toBeNull();

    expect(statements).toHaveLength(2);
    expect(statements[0].query).toContain('INSERT INTO agent_gc_candidates');
    expect(statements[0].query).toContain('chat_transcripts.head_revision > 0');
    expect(statements[0].query).not.toContain('TRIM(chats.description)');
    expect(Number(statements[0].values[0]) - Number(statements[0].values[1])).toBe(AGENT_GC_GRACE_PERIOD_MS);
    expect(statements[1].query).toContain('SET is_deleted = 1');
    expect(statements[1].query).not.toContain('TRIM(description)');
    expect(statements[1].values).toEqual(['user-1', 'chat-1', 'chat-1']);
  });

  it('discards a titled empty chat while preserving chats with durable content', async () => {
    const database = emptyChatDatabase();
    const insertChat = database.sqlite.prepare(
      `INSERT INTO chats (
         id, creator_id, initial_id, url_id, description, is_deleted
       ) VALUES (?, 'owner', ?, NULL, ?, 0)`,
    );
    insertChat.run('empty-row', 'empty', '**Generated title**');
    insertChat.run('message-row', 'message', 'Message project');
    for (const chatId of ['empty-row', 'message-row']) {
      database.sqlite
        .prepare(
          `INSERT INTO chat_transcripts (chat_id, subchat_index, generation, head_revision)
           VALUES (?, 0, 0, ?)`,
        )
        .run(chatId, chatId === 'message-row' ? 1 : 0);
    }

    await discardEmptyChat(database.db, { sessionId: 'owner', id: 'empty' });
    await discardEmptyChat(database.db, { sessionId: 'owner', id: 'message' });

    expect(database.sqlite.prepare(`SELECT id, is_deleted FROM chats ORDER BY id`).all()).toEqual([
      { id: 'empty-row', is_deleted: 1 },
      { id: 'message-row', is_deleted: 0 },
    ]);
    expect(database.sqlite.prepare(`SELECT chat_id FROM agent_gc_candidates`).all()).toEqual([
      { chat_id: 'empty-row' },
    ]);
  });
});

describe('bounded chat reads', () => {
  it('uses the row id to paginate chats that have identical timestamps', async () => {
    const timestamp = '2026-02-03T04:05:06.000Z';
    const historyRows = ['row-c', 'row-b', 'row-a'].map((rowId) => ({
      row_id: rowId,
      initial_id: `initial-${rowId}`,
      url_id: null,
      description: null,
      timestamp,
    }));
    const all = vi
      .fn()
      .mockResolvedValueOnce({ results: historyRows })
      .mockResolvedValueOnce({ results: historyRows.slice(2) });
    const bind = vi.fn(() => ({ all }));
    const prepare = vi.fn(() => ({ bind }));
    const db = { prepare } as unknown as D1Database;

    const firstPage = await getAllChats(db, { sessionId: 'user-1', limit: 2 });
    const lastPage = await getAllChats(db, {
      sessionId: 'user-1',
      limit: 2,
      cursor: firstPage.nextCursor,
    });

    expect(firstPage.items.map((item) => item.initialId)).toEqual(['initial-row-c', 'initial-row-b']);
    expect(firstPage.nextCursor).toEqual({ timestamp, rowId: 'row-b' });
    expect(lastPage.items.map((item) => item.initialId)).toEqual(['initial-row-a']);
    expect(lastPage.nextCursor).toBeUndefined();
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining('ORDER BY chats.timestamp DESC, chats.id DESC'));
    expect(prepare).toHaveBeenLastCalledWith(expect.stringContaining('(chats.timestamp, chats.id) < (?, ?)'));
    expect(bind).toHaveBeenNthCalledWith(1, 'user-1', 3);
    expect(bind).toHaveBeenNthCalledWith(2, 'user-1', timestamp, 'row-b', 3);
  });

  it('caps the subchat query and advances from the last returned index', async () => {
    const subchatRows = [0, 1, 2].map((subchatIndex) => ({
      subchat_index: subchatIndex,
      description: null,
      updated_at: subchatIndex,
      generation: 0,
      agent_name: `chat--transcript-${subchatIndex}-0`,
    }));
    const all = vi.fn().mockResolvedValue({ results: subchatRows });
    const first = vi.fn().mockResolvedValue({
      id: 'chat-row',
      creator_id: 'user-1',
      initial_id: 'chat',
      url_id: null,
      description: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      last_subchat_index: 2,
      is_deleted: 0,
    });
    const binds: unknown[][] = [];
    const prepare = vi.fn((query: string) => ({
      bind: vi.fn((...values: unknown[]) => {
        binds.push(values);
        return query.includes('SELECT * FROM chats') ? { first } : { all };
      }),
    }));

    const page = await getSubchats({ prepare } as unknown as D1Database, {
      sessionId: 'user-1',
      chatId: 'chat',
      limit: 2,
    });

    expect(page.items.map((item) => item.subchatIndex)).toEqual([0, 1]);
    expect(page.nextCursor).toEqual({ subchatIndex: 1 });
    expect(prepare).toHaveBeenLastCalledWith(expect.stringContaining('LIMIT ?'));
    expect(binds).toEqual([
      ['user-1', 'chat', 'chat'],
      ['chat-row', -1, 3],
    ]);
  });
});

describe('chat deletion', () => {
  it('queues BuilderAgent cleanup before atomically clearing chat metadata', async () => {
    const statements: Array<{ query: string; values: unknown[] }> = [];
    const db = {
      prepare: vi.fn((query: string) => ({
        bind: vi.fn((...values: unknown[]) => ({
          query,
          values,
          first: vi
            .fn()
            .mockResolvedValue(query.includes('SELECT * FROM chats') ? { id: 'chat-row', creator_id: 'owner' } : null),
          run: vi.fn(),
        })),
      })),
      batch: vi.fn(async (batch: Array<{ query: string; values: unknown[] }>) => {
        statements.push(...batch);
        return [];
      }),
    } as unknown as D1Database;

    await removeChat(db, { sessionId: 'owner', id: 'chat' });

    expect(statements).toHaveLength(2);
    expect(statements[0].query).toContain('INSERT INTO agent_gc_candidates');
    expect(statements[0].query).toContain('JOIN chat_transcripts');
    expect(Number(statements[0].values[0]) - Number(statements[0].values[1])).toBe(AGENT_GC_GRACE_PERIOD_MS);
    expect(statements[1].query).toContain('SET is_deleted = 1');
    expect(statements[1].query).not.toContain('snapshot_key');
  });
});

describe('transcript generation transitions', () => {
  it('rejects subchat creation at the validated index ceiling', async () => {
    const first = vi.fn().mockResolvedValue({
      id: 'chat-row',
      creator_id: 'user-1',
      initial_id: 'chat',
      url_id: null,
      description: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      last_subchat_index: 10_000,
      is_deleted: 0,
    });
    const prepare = vi.fn(() => ({ bind: vi.fn(() => ({ first })) }));

    await expect(
      createSubchat({ prepare } as unknown as D1Database, { sessionId: 'user-1', chatId: 'chat' }),
    ).rejects.toThrow('maximum number of subchats');
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it('creates a subchat with its own agent identity and parent checkpoint', async () => {
    const database = new ChatServiceDatabase();

    const created = await createSubchat(database.db, { sessionId: 'user-1', chatId: 'chat' });

    expect(created).toBe(3);
    const transcriptInsert = database.batchStatements[0];
    expect(transcriptInsert.query).toContain('INSERT INTO chat_transcripts');
    expect(transcriptInsert.values.slice(0, 10)).toEqual([
      'chat-row',
      3,
      0,
      'chat--transcript-3-0',
      0,
      null,
      0,
      2,
      4,
      9,
    ]);
    expect(transcriptInsert.query).toContain('WHERE chat_id = ? AND subchat_index = ? AND generation = ?');
    expect(transcriptInsert.query).toContain('chats.is_deleted = 0');
    expect(transcriptInsert.values.at(-1)).toBe('user-1');
    expect(database.batchStatements[1].query).toContain('last_subchat_index = ?');
  });

  it('rejects subchat creation when the parent generation changes before the batch', async () => {
    const database = new ChatServiceDatabase([0, 0]);

    await expect(createSubchat(database.db, { sessionId: 'user-1', chatId: 'chat' })).rejects.toThrow(
      'Chat transcript changed while creating a subchat',
    );
  });

  it('adopts an exactly matching subchat transition when D1 commits before losing its acknowledgement', async () => {
    const database = new ChatServiceDatabase([1, 1], true);

    await expect(createSubchat(database.db, { sessionId: 'user-1', chatId: 'chat' })).resolves.toBe(3);

    expect(database.committedBatch).toBe(true);
    expect(database.receiptStatements).toHaveLength(1);
    expect(database.receiptStatements[0].query).toContain('chats.creator_id = ?');
    expect(database.receiptStatements[0].query).toContain('transcripts.transition_token = ?');
    expect(database.receiptStatements[0].query).toContain('chats.last_subchat_index = ?');
  });

  it('preserves the batch failure when the transition receipt does not match exactly', async () => {
    const database = new ChatServiceDatabase([1, 1], true, false);

    await expect(createSubchat(database.db, { sessionId: 'user-1', chatId: 'chat' })).rejects.toThrow(
      'D1 acknowledgement lost',
    );
  });
});

function emptyChatDatabase(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE chats (
      id TEXT PRIMARY KEY,
      creator_id TEXT NOT NULL,
      initial_id TEXT NOT NULL,
      url_id TEXT,
      description TEXT,
      is_deleted INTEGER NOT NULL
    );
    CREATE TABLE chat_transcripts (
      chat_id TEXT NOT NULL,
      subchat_index INTEGER NOT NULL,
      generation INTEGER NOT NULL,
      head_revision INTEGER NOT NULL
    );
    CREATE TABLE agent_gc_candidates (
      chat_id TEXT NOT NULL,
      initial_id TEXT NOT NULL,
      subchat_index INTEGER NOT NULL,
      next_generation INTEGER NOT NULL,
      max_generation INTEGER NOT NULL,
      not_before INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL,
      PRIMARY KEY (chat_id, subchat_index)
    );
  `);
  const db = {
    prepare: (query: string) => ({
      bind: (...values: unknown[]) => ({
        run: async () => {
          const result = sqlite.prepare(query).run(...(values as SQLInputValue[]));
          return { success: true, meta: { changes: Number(result.changes) } } as D1Result;
        },
      }),
    }),
    batch: async (statements: D1PreparedStatement[]) => {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = await Promise.all(statements.map((statement) => statement.run()));
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
  return { sqlite, db };
}

type BoundStatement = {
  query: string;
  values: unknown[];
  run: () => Promise<D1Result>;
};

class ChatServiceDatabase {
  readonly batchStatements: BoundStatement[] = [];
  readonly receiptStatements: Array<{ query: string; values: unknown[] }> = [];
  committedBatch = false;
  private committedReceiptValues: unknown[] | null = null;

  private readonly chat: ChatRow = {
    id: 'chat-row',
    creator_id: 'user-1',
    initial_id: 'chat',
    url_id: null,
    description: null,
    timestamp: '2026-01-01T00:00:00.000Z',
    last_subchat_index: 2,
    is_deleted: 0,
  };

  private readonly transcript: ChatTranscriptRow = {
    chat_id: 'chat-row',
    subchat_index: 2,
    generation: 4,
    agent_name: 'chat--transcript-2-4',
    head_revision: 9,
    head_digest: 'a'.repeat(64),
    head_message_count: 8,
    last_message_rank: 5,
    part_index: 1,
    description: 'Feature',
    parent_subchat_index: 1,
    parent_generation: 0,
    parent_revision: 3,
    transition_token: 'previous-transition',
    created_at: 1,
    updated_at: 2,
  };

  constructor(
    private readonly batchChanges = [1, 1],
    private readonly throwAfterBatchCommit = false,
    private readonly receiptMatches = true,
  ) {}

  readonly db = {
    prepare: (query: string) => ({
      bind: (...values: unknown[]) => {
        const statement: BoundStatement = {
          query,
          values,
          run: async () => ({ success: true, meta: { changes: 1 } }) as D1Result,
        };
        return {
          ...statement,
          first: async () => this.first(query, values),
        };
      },
    }),
    batch: async (statements: BoundStatement[]) => {
      this.batchStatements.push(...statements);
      const results = statements.map(
        (_statement, index) => ({ success: true, meta: { changes: this.batchChanges[index] ?? 1 } }) as D1Result,
      );
      if (this.throwAfterBatchCommit) {
        this.committedBatch = true;
        this.committedReceiptValues = this.expectedReceiptValues(statements);
        throw new Error('D1 acknowledgement lost');
      }
      return results;
    },
  } as unknown as D1Database;

  private first(query: string, values: unknown[]): ChatRow | ChatTranscriptRow | { found: number } | null {
    if (query.includes('SELECT 1 AS found')) {
      this.receiptStatements.push({ query, values });
      return this.committedBatch &&
        this.receiptMatches &&
        JSON.stringify(values) === JSON.stringify(this.committedReceiptValues)
        ? { found: 1 }
        : null;
    }
    if (query.includes('FROM chats')) {
      return this.chat;
    }
    if (query.includes('FROM chat_transcripts')) {
      return this.transcript;
    }
    return null;
  }

  private expectedReceiptValues(statements: BoundStatement[]): unknown[] {
    const [transcript] = statements;
    return [
      transcript.values[0],
      transcript.values.at(-1),
      transcript.values[1],
      transcript.values[1],
      transcript.values[3],
      transcript.values[10],
      transcript.values[7],
      transcript.values[8],
      transcript.values[9],
    ];
  }
}
