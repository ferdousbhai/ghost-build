import { describe, expect, test, vi } from 'vitest';
import { ensureInitialChat, insertChatWithState, updateStorageState } from './chat-repository.server';
import type { ChatMessageStateRow, ChatRow } from './types';

const chat = {
  id: 'chat-row',
  creator_id: 'session',
  initial_id: 'chat',
  url_id: null,
  description: null,
  timestamp: '2026-01-01T00:00:00.000Z',
  snapshot_key: null,
  last_message_rank: null,
  last_subchat_index: 0,
  is_deleted: 0,
} satisfies ChatRow;

describe('updateStorageState object ownership', () => {
  test('rejects both uploaded objects for an older message rank', async () => {
    const database = new StorageStateDatabase(storageState({ last_message_rank: 5, part_index: 0 }));

    const result = await updateStorageState(database.db, updateArgs({ lastMessageRank: 4, partIndex: 2 }));

    expect(result).toEqual({
      retainedStorageKey: false,
      retainedSnapshotKey: false,
      displacedKeys: [],
    });
  });

  test('retains only a snapshot that atomically fills an empty slot on a duplicate write', async () => {
    const database = new StorageStateDatabase(
      storageState({ last_message_rank: 5, part_index: 2, snapshot_key: null }),
    );

    const result = await updateStorageState(database.db, updateArgs({ lastMessageRank: 5, partIndex: 2 }));

    expect(result).toEqual({
      retainedStorageKey: false,
      retainedSnapshotKey: true,
      displacedKeys: [],
    });
    expect(database.state.snapshot_key).toBe('snapshot-new');
  });

  test('uses compare-and-swap so a concurrent stale same-rank write does not claim retained keys', async () => {
    const database = new StorageStateDatabase(storageState({ last_message_rank: 5, part_index: 1 }));
    database.reverseFirstCasPair = true;

    const [partTwo, partThree] = await Promise.all([
      updateStorageState(
        database.db,
        updateArgs({ partIndex: 2, storageKey: 'message-two', snapshotKey: 'snapshot-two' }),
      ),
      updateStorageState(
        database.db,
        updateArgs({ partIndex: 3, storageKey: 'message-three', snapshotKey: 'snapshot-three' }),
      ),
    ]);

    expect(database.state).toMatchObject({
      part_index: 3,
      storage_key: 'message-three',
      snapshot_key: 'snapshot-three',
    });
    expect(partThree).toMatchObject({ retainedStorageKey: true, retainedSnapshotKey: true });
    expect(partThree.displacedKeys).toEqual(['message-old', 'snapshot-old']);
    expect(partTwo).toMatchObject({ retainedStorageKey: false, retainedSnapshotKey: false });
    expect(database.gcCandidates).toEqual(expect.arrayContaining(['message-old', 'snapshot-old']));
  });

  test('persists the initial description atomically after a failed write is retried', async () => {
    const database = new StorageStateDatabase(storageState({ last_message_rank: 5, part_index: 1, description: null }));
    database.failNextCas = true;
    const args = updateArgs({ partIndex: 2, initialDescription: 'Build a durable chat' });

    await expect(updateStorageState(database.db, args)).rejects.toThrow('database unavailable');
    expect(database.state.description).toBeNull();
    const retry = await updateStorageState(database.db, args);

    expect(database.state.description).toBe('Build a durable chat');
    expect(retry.retainedStorageKey).toBe(true);
    expect(retry.retainedSnapshotKey).toBe(true);
  });
});

describe('insertChatWithState', () => {
  test('submits chat and state creation as one D1 batch and exposes an atomic batch failure', async () => {
    const run = vi.fn();
    const batch = vi.fn().mockRejectedValue(new Error('atomic batch failed'));
    const db = {
      prepare: vi.fn(() => ({ bind: vi.fn(() => ({ run })) })),
      batch,
    } as unknown as D1Database;

    await expect(
      insertChatWithState(
        db,
        { id: 'chat-row', creatorId: 'session', initialId: 'chat' },
        { subchatIndex: 0, lastMessageRank: 0, partIndex: 0, storageKey: 'history-key' },
      ),
    ).rejects.toThrow('atomic batch failed');

    expect(batch).toHaveBeenCalledOnce();
    expect(batch.mock.calls[0][0]).toHaveLength(2);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('ensureInitialChat', () => {
  test('concurrent initialization returns one active chat with one initial state', async () => {
    const database = new InitialChatDatabase();

    const [first, second] = await Promise.all([
      ensureInitialChat(database.db, { id: 'chat-row-a', creatorId: 'session', initialId: 'chat' }),
      ensureInitialChat(database.db, { id: 'chat-row-b', creatorId: 'session', initialId: 'chat' }),
    ]);

    expect(first.id).toBe(second.id);
    expect(database.activeChats).toHaveLength(1);
    expect(database.states).toEqual([{ chatId: first.id, lastMessageRank: -1, partIndex: -1 }]);
  });

  test('does not reuse a globally named BuilderAgent after its chat was soft-deleted', async () => {
    const database = new InitialChatDatabase();
    const previous = await ensureInitialChat(database.db, {
      id: 'chat-row-a',
      creatorId: 'session',
      initialId: 'chat',
    });
    database.softDelete(previous.id);

    await expect(
      ensureInitialChat(database.db, {
        id: 'chat-row-b',
        creatorId: 'session',
        initialId: 'chat',
      }),
    ).rejects.toThrow('Unable to initialize chat');

    expect(database.activeChats).toHaveLength(0);
    expect(database.states).toHaveLength(1);
  });
});

function updateArgs(overrides: Partial<Parameters<typeof updateStorageState>[1]> = {}) {
  return {
    sessionId: 'session',
    chatId: 'chat',
    storageKey: 'message-new',
    snapshotKey: 'snapshot-new',
    lastMessageRank: 5,
    subchatIndex: 0,
    partIndex: 2,
    initialDescription: null,
    ...overrides,
  };
}

function storageState(overrides: Partial<ChatMessageStateRow> = {}): ChatMessageStateRow {
  return {
    id: 'state-row',
    chat_id: chat.id,
    storage_key: 'message-old',
    subchat_index: 0,
    last_message_rank: 5,
    part_index: 0,
    snapshot_key: 'snapshot-old',
    description: null,
    created_at: 0,
    ...overrides,
  };
}

class StorageStateDatabase {
  state: ChatMessageStateRow;
  reverseFirstCasPair = false;
  failNextCas = false;
  gcCandidates: string[] = [];
  #casRuns = 0;
  #firstCas: (() => void) | null = null;

  constructor(state: ChatMessageStateRow) {
    this.state = state;
  }

  readonly db = {
    prepare: (query: string) => ({
      bind: (...values: unknown[]) => ({
        first: async () => this.first(query, values),
        run: async () => this.run(query, values),
      }),
    }),
    batch: async (statements: D1PreparedStatement[]) =>
      Promise.all(statements.map((statement) => statement.run())) as Promise<D1Result<unknown>[]>,
  } as unknown as D1Database;

  private first(query: string, values: unknown[]) {
    if (query.includes('FROM chats')) {
      return { ...chat };
    }
    if (query.includes('WHERE id = ?')) {
      return values[0] === this.state.id ? { ...this.state } : null;
    }
    return { ...this.state };
  }

  private async run(query: string, values: unknown[]) {
    if (query.includes('INSERT INTO object_gc_candidates')) {
      this.gcCandidates.push(values[0] as string);
      return changed(1);
    }
    if (query.includes('AND storage_key IS ?')) {
      if (this.reverseFirstCasPair && this.#casRuns++ === 0) {
        await new Promise<void>((resolve) => {
          this.#firstCas = resolve;
        });
      } else if (this.reverseFirstCasPair && this.#firstCas) {
        const release = this.#firstCas;
        this.#firstCas = null;
        const result = this.applyCas(values);
        release();
        return result;
      }
      return this.applyCas(values);
    }
    if (query.includes('SET snapshot_key = COALESCE(snapshot_key, ?)')) {
      this.state.snapshot_key ??= values[0] as string | null;
      this.state.description ??= values[1] as string | null;
      return changed(1);
    }
    return changed(1);
  }

  private applyCas(values: unknown[]) {
    if (this.failNextCas) {
      this.failNextCas = false;
      throw new Error('database unavailable');
    }
    const expected = {
      id: values[4],
      rank: values[5],
      part: values[6],
      storage: values[7],
      snapshot: values[8],
    };
    if (
      expected.id !== this.state.id ||
      expected.rank !== this.state.last_message_rank ||
      expected.part !== this.state.part_index ||
      expected.storage !== this.state.storage_key ||
      expected.snapshot !== this.state.snapshot_key
    ) {
      return changed(0);
    }
    this.state.storage_key = (values[0] as string | null) ?? this.state.storage_key;
    this.state.part_index = values[1] as number;
    this.state.snapshot_key = (values[2] as string | null) ?? this.state.snapshot_key;
    this.state.description ??= values[3] as string | null;
    return changed(1);
  }
}

class InitialChatDatabase {
  readonly chats: ChatRow[] = [];
  readonly states: Array<{ chatId: string; lastMessageRank: number; partIndex: number }> = [];

  get activeChats(): ChatRow[] {
    return this.chats.filter((candidate) => candidate.is_deleted === 0);
  }

  softDelete(id: string): void {
    const existing = this.chats.find((candidate) => candidate.id === id);
    if (existing) {
      existing.is_deleted = 1;
    }
  }

  readonly db = {
    prepare: (query: string) => ({
      bind: (...values: unknown[]) => ({
        first: async () => this.first(query, values),
        run: async () => this.run(query, values),
      }),
    }),
    batch: async (statements: D1PreparedStatement[]) => {
      const results = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      return results;
    },
  } as unknown as D1Database;

  private first(query: string, values: unknown[]) {
    if (!query.includes('WHERE creator_id = ? AND initial_id = ? AND is_deleted = 0')) {
      return null;
    }
    return (
      this.chats.find(
        (candidate) =>
          candidate.creator_id === values[0] && candidate.initial_id === values[1] && candidate.is_deleted === 0,
      ) ?? null
    );
  }

  private run(query: string, values: unknown[]) {
    if (query.includes('INSERT INTO chats')) {
      const [id, creatorId, initialId] = values as [string, string, string];
      const exists = this.chats.some((candidate) => candidate.initial_id === initialId);
      if (exists) {
        return changed(0);
      }
      this.chats.push({
        id,
        creator_id: creatorId,
        initial_id: initialId,
        url_id: null,
        description: null,
        timestamp: values[5] as string,
        snapshot_key: null,
        last_message_rank: null,
        last_subchat_index: 0,
        is_deleted: 0,
      });
      return changed(1);
    }
    if (query.includes('INSERT INTO chat_message_states')) {
      const chatId = values[2] as string;
      const matchingChat = this.chats.some(
        (candidate) =>
          candidate.id === chatId &&
          candidate.creator_id === values[3] &&
          candidate.initial_id === values[4] &&
          candidate.is_deleted === 0,
      );
      if (matchingChat && !this.states.some((state) => state.chatId === chatId && state.lastMessageRank === -1)) {
        this.states.push({ chatId, lastMessageRank: -1, partIndex: -1 });
        return changed(1);
      }
      return changed(0);
    }
    return changed(0);
  }
}

function changed(changes: number) {
  return { success: true, meta: { changes } };
}
