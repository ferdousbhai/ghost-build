import { describe, expect, it, vi } from 'vitest';
import {
  createSubchat,
  discardEmptyChat,
  getAllChats,
  getSubchats,
  removeChat,
  rewindChat,
  setGeneratedDescriptionIfMissing,
} from './chat-service.server';
import type { ChatMessageStateRow, ChatRow, ChatTranscriptRow } from './types';
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

describe('empty chat lifecycle', () => {
  it('keeps drafts without persisted messages out of project history', async () => {
    const all = vi.fn().mockResolvedValue({ results: [] });
    const bind = vi.fn(() => ({ all }));
    const prepare = vi.fn(() => ({ bind }));

    await expect(getAllChats({ prepare } as unknown as D1Database, { sessionId: 'user-1' })).resolves.toEqual({
      items: [],
      nextCursor: undefined,
    });

    expect(prepare).toHaveBeenCalledWith(expect.stringContaining('chat_message_states.last_message_rank >= 0'));
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
    expect(statements[0].query).toContain('chat_message_states.last_message_rank >= 0');
    expect(Number(statements[0].values[0]) - Number(statements[0].values[1])).toBe(AGENT_GC_GRACE_PERIOD_MS);
    expect(statements[1].query).toContain('SET is_deleted = 1');
    expect(statements[1].values).toEqual(['user-1', 'chat-1', 'chat-1']);
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
      snapshot_key: null,
      last_message_rank: 0,
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
  it('queues every R2 reference before atomically clearing a deleted chat', async () => {
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

    expect(statements).toHaveLength(7);
    expect(statements[0].query).toContain('INSERT INTO object_gc_candidates');
    expect(statements[0].query).toContain('SELECT storage_key FROM chat_message_states');
    expect(statements[0].query).toContain('SELECT snapshot_key FROM chat_message_states');
    expect(statements[0].query).toContain('SELECT chat_history_key FROM shares');
    expect(statements[0].query).toContain('SELECT thumbnail_image_key FROM social_shares');
    expect(statements[1].query).toContain('INSERT INTO agent_gc_candidates');
    expect(statements[1].query).toContain('JOIN chat_transcripts');
    expect(Number(statements[1].values[0]) - Number(statements[1].values[1])).toBe(AGENT_GC_GRACE_PERIOD_MS);
    expect(statements[2].query).toContain("SET status = 'released'");
    expect(statements[2].query).toContain('SELECT thumbnail_image_key FROM social_shares');
    expect(statements[3].query).toContain('SET is_deleted = 1, snapshot_key = NULL');
    expect(statements.slice(4).map((statement) => statement.query)).toEqual([
      expect.stringContaining('DELETE FROM shares'),
      expect.stringContaining('DELETE FROM social_shares'),
      expect.stringContaining('DELETE FROM chat_message_states'),
    ]);
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
      snapshot_key: null,
      last_message_rank: 0,
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
      7,
    ]);
    expect(transcriptInsert.query).toContain('WHERE chat_id = ? AND subchat_index = ? AND generation = ?');
    expect(transcriptInsert.query).toContain('chats.is_deleted = 0');
    expect(transcriptInsert.values.at(-1)).toBe('user-1');
    expect(database.batchStatements[1].query).toContain('transition_token = ?');
    expect(database.batchStatements[2].query).toContain('last_subchat_index = ?');
  });

  it('rejects subchat creation when the parent generation changes before the batch', async () => {
    const database = new ChatServiceDatabase([0, 0, 0]);

    await expect(createSubchat(database.db, { sessionId: 'user-1', chatId: 'chat' })).rejects.toThrow(
      'Chat transcript changed while creating a subchat',
    );
  });

  it('adopts an exactly matching subchat transition when D1 commits before losing its acknowledgement', async () => {
    const database = new ChatServiceDatabase([1, 1, 1], true);

    await expect(createSubchat(database.db, { sessionId: 'user-1', chatId: 'chat' })).resolves.toBe(3);

    expect(database.committedBatch).toBe(true);
    expect(database.receiptStatements).toHaveLength(1);
    expect(database.receiptStatements[0].query).toContain('chats.creator_id = ?');
    expect(database.receiptStatements[0].query).toContain('transcripts.transition_token = ?');
    expect(database.receiptStatements[0].query).toContain('states.id = ?');
    expect(database.receiptStatements[0].query).toContain('chats.last_subchat_index = ?');
  });

  it('rotates the agent generation and ties every rewind write to one transition token', async () => {
    const database = new ChatServiceDatabase();

    await expect(
      rewindChat(database.db, { sessionId: 'user-1', chatId: 'chat', subchatIndex: 2, lastMessageRank: 5 }),
    ).resolves.toBeNull();

    const [transcriptUpdate, stateInsert, chatUpdate] = database.batchStatements;
    expect(transcriptUpdate.query).toContain('SET generation = ?');
    expect(transcriptUpdate.query).toContain('chats.is_deleted = 0');
    expect(transcriptUpdate.values[1]).toBe('chat--transcript-2-5');
    const transitionToken = transcriptUpdate.values[5];
    expect(transitionToken).toEqual(expect.any(String));
    expect(stateInsert.values.at(-1)).toBe(transitionToken);
    expect(chatUpdate.values.at(-1)).toBe(transitionToken);
  });

  it('rejects a rewind that loses the transcript-generation compare-and-swap', async () => {
    const database = new ChatServiceDatabase([0, 0, 0]);

    await expect(
      rewindChat(database.db, { sessionId: 'user-1', chatId: 'chat', subchatIndex: 2, lastMessageRank: 5 }),
    ).rejects.toThrow('Chat transcript changed while rewinding');
  });

  it('rejects a rewind unless its chat pointer update also commits', async () => {
    const database = new ChatServiceDatabase([1, 1, 0]);

    await expect(
      rewindChat(database.db, { sessionId: 'user-1', chatId: 'chat', subchatIndex: 2, lastMessageRank: 5 }),
    ).rejects.toThrow('Chat transcript changed while rewinding');
  });

  it('adopts an exactly matching rewind transition when D1 commits before losing its acknowledgement', async () => {
    const database = new ChatServiceDatabase([1, 1, 1], true);

    await expect(
      rewindChat(database.db, { sessionId: 'user-1', chatId: 'chat', subchatIndex: 2, lastMessageRank: 5 }),
    ).resolves.toBeNull();

    expect(database.committedBatch).toBe(true);
    expect(database.receiptStatements).toHaveLength(1);
    expect(database.receiptStatements[0].query).toContain('chats.creator_id = ?');
    expect(database.receiptStatements[0].query).toContain('transcripts.generation = ?');
    expect(database.receiptStatements[0].query).toContain('transcripts.transition_token = ?');
    expect(database.receiptStatements[0].query).toContain('states.id = ?');
    expect(database.receiptStatements[0].query).toContain('chats.last_message_rank = ?');
  });

  it('preserves the batch failure when the transition receipt does not match exactly', async () => {
    const database = new ChatServiceDatabase([1, 1, 1], true, false);

    await expect(createSubchat(database.db, { sessionId: 'user-1', chatId: 'chat' })).rejects.toThrow(
      'D1 acknowledgement lost',
    );
  });
});

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
    snapshot_key: null,
    last_message_rank: null,
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
    parent_subchat_index: 1,
    parent_generation: 0,
    parent_revision: 3,
    transition_token: 'previous-transition',
    created_at: 1,
    updated_at: 2,
  };

  private readonly state: ChatMessageStateRow = {
    id: 'state-row',
    chat_id: 'chat-row',
    storage_key: 'history-key',
    subchat_index: 2,
    last_message_rank: 5,
    part_index: 1,
    snapshot_key: 'snapshot-key',
    description: 'Feature',
    created_at: 2,
    transcript_generation: 4,
    transcript_revision: 7,
    transcript_digest: 'b'.repeat(64),
  };

  constructor(
    private readonly batchChanges = [1, 1, 1],
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

  private first(
    query: string,
    values: unknown[],
  ): ChatRow | ChatTranscriptRow | ChatMessageStateRow | { found: number } | null {
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
    if (query.includes('FROM chat_message_states')) {
      return this.state;
    }
    return null;
  }

  private expectedReceiptValues(statements: BoundStatement[]): unknown[] {
    const [transcript, state] = statements;
    if (transcript.query.includes('UPDATE chat_transcripts')) {
      return [
        transcript.values[7],
        transcript.values[10],
        transcript.values[2],
        state.values[4],
        transcript.values[2],
        transcript.values[0],
        transcript.values[1],
        transcript.values[5],
        transcript.values[2],
        transcript.values[3],
        transcript.values[4],
        state.values[0],
        state.values[3],
        state.values[9],
        state.values[2],
        state.values[4],
        state.values[5],
        state.values[6],
        state.values[7],
      ];
    }
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
      state.values[0],
      state.values[2],
      state.values[3],
    ];
  }
}
