import { describe, expect, test, vi } from 'vitest';
import {
  enforceChatStorageRetention,
  ensureInitialChat,
  insertChatWithState,
  MAX_RETAINED_CHAT_STORAGE_STATES,
  updateStorageState,
} from './chat-repository.server';
import { ChatStorageRetentionError } from './errors';
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
      accepted: false,
      retainedStorageKey: false,
      retainedSnapshotKey: false,
      displacedKeys: [],
    });
  });

  test('rejects a checkpoint from an obsolete transcript generation', async () => {
    const database = new StorageStateDatabase(storageState({ transcript_generation: 1 }));

    const result = await updateStorageState(database.db, updateArgs());

    expect(result).toEqual({
      accepted: false,
      retainedStorageKey: false,
      retainedSnapshotKey: false,
      displacedKeys: [],
    });
  });

  test('retains only a snapshot that atomically fills an empty slot on a duplicate write', async () => {
    const database = new StorageStateDatabase(
      storageState({
        last_message_rank: 5,
        part_index: 2,
        snapshot_key: null,
        transcript_revision: 1,
        transcript_digest: 'a'.repeat(64),
      }),
    );

    const result = await updateStorageState(database.db, updateArgs({ lastMessageRank: 5, partIndex: 2 }));

    expect(result).toEqual({
      accepted: true,
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

  test('atomically rejects a new checkpoint when a concurrent writer consumed the retained-state slot', async () => {
    const database = new StorageStateDatabase(storageState({ last_message_rank: 4 }), MAX_RETAINED_CHAT_STORAGE_STATES);

    await expect(updateStorageState(database.db, updateArgs({ lastMessageRank: 5 }))).rejects.toBeInstanceOf(
      ChatStorageRetentionError,
    );
    expect(database.preparedQueries.some((query) => query.includes('SELECT COUNT(*) FROM chat_message_states'))).toBe(
      true,
    );
  });

  test('returns a rejected CAS when chat deletion wins before the storage-write batch', async () => {
    const database = new StorageStateDatabase(storageState({ last_message_rank: 5, part_index: 1 }));
    database.deleteBeforeNextBatch = true;

    const result = await updateStorageState(database.db, updateArgs({ partIndex: 2 }));

    expect(result).toEqual({
      accepted: false,
      retainedStorageKey: false,
      retainedSnapshotKey: false,
      displacedKeys: [],
    });
    expect(database.state).toMatchObject({
      storage_key: 'message-old',
      snapshot_key: 'snapshot-old',
      part_index: 1,
    });
    expect(database.preparedQueries.filter((query) => query.includes('UPDATE chat_transcripts'))).toEqual([
      expect.stringContaining('chats.is_deleted = 0'),
    ]);
  });
});

describe('chat checkpoint retention', () => {
  test('reserves one state before upload and queues pruned object keys for GC', async () => {
    const database = new RetentionDatabase(MAX_RETAINED_CHAT_STORAGE_STATES + 2);

    await enforceChatStorageRetention(database.db, { chatId: chat.id, reserveStates: 1 });

    expect(database.states).toHaveLength(MAX_RETAINED_CHAT_STORAGE_STATES - 1);
    expect(database.states.map((state) => state.id)).not.toContain('state-0');
    expect(database.gcCandidates).toEqual(
      expect.arrayContaining(['message-0', 'snapshot-0', 'message-1', 'snapshot-1', 'message-2', 'snapshot-2']),
    );
  });
});

describe('insertChatWithState', () => {
  test('submits chat and state creation as one D1 batch and exposes an atomic batch failure', async () => {
    const run = vi.fn();
    const batch = vi.fn().mockRejectedValue(new Error('atomic batch failed'));
    const db = {
      prepare: vi.fn((query: string) => ({
        bind: vi.fn((...values: unknown[]) => ({ query, values, run })),
      })),
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
    expect(batch.mock.calls[0][0]).toHaveLength(3);
    expect(batch.mock.calls[0][0][1].query).toContain('chats.creator_id = ? AND chats.is_deleted = 0');
    expect(run).not.toHaveBeenCalled();
  });

  test('returns the intended state id when the exact chat insert commits before D1 loses its acknowledgement', async () => {
    let committed = false;
    let receipt: { query: string; values: unknown[] } | null = null;
    let committedStatements: Array<{ query: string; values: unknown[] }> = [];
    const batch = vi.fn(async (statements: Array<{ query: string; values: unknown[] }>) => {
      committedStatements = statements;
      committed = true;
      throw new Error('D1 acknowledgement lost');
    });
    const db = {
      prepare: vi.fn((query: string) => ({
        bind: vi.fn((...values: unknown[]) => ({
          query,
          values,
          run: vi.fn(),
          first: vi.fn(async () => {
            if (!query.includes('SELECT 1 AS found')) {
              return null;
            }
            receipt = { query, values };
            const [chatInsert, transcriptInsert, stateInsert] = committedStatements;
            const expected = committed
              ? [
                  transcriptInsert.values[1],
                  stateInsert.values[0],
                  chatInsert.values[0],
                  chatInsert.values[1],
                  chatInsert.values[2],
                  chatInsert.values[4],
                  chatInsert.values[6],
                  chatInsert.values[8],
                  transcriptInsert.values[2],
                  transcriptInsert.values[3],
                  transcriptInsert.values[4],
                  transcriptInsert.values[5],
                  transcriptInsert.values[10],
                  stateInsert.values[2],
                  stateInsert.values[3],
                  stateInsert.values[4],
                  stateInsert.values[5],
                  stateInsert.values[6],
                  stateInsert.values[7],
                  stateInsert.values[9],
                  stateInsert.values[10],
                  stateInsert.values[11],
                ]
              : null;
            return JSON.stringify(values) === JSON.stringify(expected) ? { found: 1 } : null;
          }),
        })),
      })),
      batch,
    } as unknown as D1Database;

    await expect(
      insertChatWithState(
        db,
        {
          id: 'clone-chat',
          creatorId: 'session',
          initialId: 'clone',
          description: 'Shared app',
          snapshotKey: 'snapshot-key',
          lastSubchatIndex: 2,
        },
        {
          id: 'clone-state',
          subchatIndex: 2,
          lastMessageRank: 4,
          partIndex: 1,
          storageKey: 'history-key',
          snapshotKey: 'snapshot-key',
          description: 'Shared app',
        },
        { kind: 'legacy-share', code: 'a'.repeat(32), parentChatId: 'parent-chat' },
      ),
    ).resolves.toBe('clone-state');

    expect(receipt).not.toBeNull();
    expect(receipt!.query).toContain('chats.creator_id = ?');
    expect(receipt!.query).toContain('transcripts.transition_token = ?');
    expect(receipt!.query).toContain('states.id = ?');
    expect(receipt!.query).toContain('chats.last_subchat_index = ?');
    expect(receipt!.values).toEqual(
      expect.arrayContaining(['clone-chat', 'clone-state', 'session', 'clone', 'history-key', 'snapshot-key']),
    );
  });

  test.each([
    {
      authorization: { kind: 'legacy-share', code: 'a'.repeat(32), parentChatId: 'parent-chat' } as const,
      expectedTable: 'FROM shares',
    },
    {
      authorization: { kind: 'social-share', code: 'b'.repeat(32), parentChatId: 'parent-chat' } as const,
      expectedTable: 'FROM social_shares',
    },
  ])(
    'atomically rejects a $authorization.kind clone when revocation commits before its insertion batch',
    async ({ authorization, expectedTable }) => {
      const database = new CloneAuthorizationDatabase();
      database.revokeBeforeBatch = true;

      await expect(
        insertChatWithState(
          database.db,
          { id: 'clone-chat', creatorId: 'session', initialId: 'clone' },
          { subchatIndex: 0, lastMessageRank: 1, partIndex: 0, storageKey: 'history-key' },
          authorization,
        ),
      ).rejects.toThrow('Invalid share link');

      expect(database.chatCreated).toBe(false);
      expect(database.preparedQueries[0]).toContain(expectedTable);
      expect(database.preparedQueries[0]).toContain('parent_chat.is_deleted = 0');
      if (authorization.kind === 'social-share') {
        expect(database.preparedQueries[0]).toContain('social_shares.is_shared = 1');
      }
    },
  );

  test('preserves atomic clone creation while the source capability and parent remain active', async () => {
    const database = new CloneAuthorizationDatabase();

    await expect(
      insertChatWithState(
        database.db,
        { id: 'clone-chat', creatorId: 'session', initialId: 'clone' },
        { subchatIndex: 0, lastMessageRank: 1, partIndex: 0, storageKey: 'history-key' },
        { kind: 'social-share', code: 'b'.repeat(32), parentChatId: 'parent-chat' },
      ),
    ).resolves.toMatch(/[0-9a-f-]{36}/);

    expect(database.chatCreated).toBe(true);
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
    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(database.activeChats).toHaveLength(1);
    expect(database.states).toEqual([{ chatId: first.id, lastMessageRank: -1, partIndex: -1 }]);
  });

  test('allows only one tenant to claim the same unprovisioned initial ID', async () => {
    const database = new InitialChatDatabase();

    const results = await Promise.allSettled([
      ensureInitialChat(database.db, { id: 'chat-row-a', creatorId: 'owner-a', initialId: 'shared-name' }),
      ensureInitialChat(database.db, { id: 'chat-row-b', creatorId: 'owner-b', initialId: 'shared-name' }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(database.activeChats).toHaveLength(1);
  });

  test('permanently reserves a deleted initial ID so a replacement cannot race deferred Agent destruction', async () => {
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

function updateArgs(
  overrides: Partial<Parameters<typeof updateStorageState>[1]> = {},
): Parameters<typeof updateStorageState>[1] {
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
    checkpoint: overrides.checkpoint ?? {
      agentName: 'chat',
      generation: 0,
      subchatIndex: 0,
      revision: 1,
      digest: 'a'.repeat(64),
      messageCount: 6,
    },
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
    transcript_generation: 0,
    transcript_revision: 0,
    transcript_digest: null,
    ...overrides,
  };
}

class StorageStateDatabase {
  state: ChatMessageStateRow;
  retainedStateCount: number;
  reverseFirstCasPair = false;
  failNextCas = false;
  deleteBeforeNextBatch = false;
  active = true;
  gcCandidates: string[] = [];
  preparedQueries: string[] = [];
  #casRuns = 0;
  #firstCas: (() => void) | null = null;

  constructor(state: ChatMessageStateRow, retainedStateCount = 1) {
    this.state = state;
    this.retainedStateCount = retainedStateCount;
  }

  readonly db = {
    prepare: (query: string) => {
      this.preparedQueries.push(query);
      return {
        bind: (...values: unknown[]) => ({
          first: async () => this.first(query, values),
          run: async () => this.run(query, values),
        }),
      };
    },
    batch: async (statements: D1PreparedStatement[]) => {
      if (this.deleteBeforeNextBatch) {
        this.deleteBeforeNextBatch = false;
        this.active = false;
      }
      return Promise.all(statements.map((statement) => statement.run())) as Promise<D1Result<unknown>[]>;
    },
  } as unknown as D1Database;

  private first(query: string, values: unknown[]) {
    if (query.includes('COUNT(*)')) {
      return { state_count: this.retainedStateCount };
    }
    if (query.includes('FROM chat_transcripts')) {
      return {
        chat_id: chat.id,
        subchat_index: 0,
        generation: this.state.transcript_generation,
        agent_name:
          this.state.transcript_generation === 0 ? 'chat' : `chat--transcript-0-${this.state.transcript_generation}`,
        head_revision: this.state.transcript_revision,
        head_digest: this.state.transcript_digest,
        head_message_count: 0,
        parent_subchat_index: null,
        parent_generation: null,
        parent_revision: null,
        created_at: 0,
        updated_at: 0,
      };
    }
    if (query.includes('FROM chats')) {
      return this.active ? { ...chat } : null;
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
    if (query.includes('UPDATE chat_transcripts')) {
      return changed(this.active ? 1 : 0);
    }
    if (query.includes('INSERT INTO chat_message_states')) {
      if (!this.active || this.retainedStateCount >= MAX_RETAINED_CHAT_STORAGE_STATES) {
        return changed(0);
      }
      this.retainedStateCount++;
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
        const result = this.applyCas(query, values);
        release();
        return result;
      }
      return this.applyCas(query, values);
    }
    if (query.includes('SET snapshot_key = COALESCE(snapshot_key, ?)')) {
      if (!this.active) {
        return changed(0);
      }
      this.state.snapshot_key ??= values[0] as string | null;
      this.state.description ??= values[1] as string | null;
      return changed(1);
    }
    return changed(1);
  }

  private applyCas(query: string, values: unknown[]) {
    if (this.failNextCas) {
      this.failNextCas = false;
      throw new Error('database unavailable');
    }
    if (!this.active) {
      return changed(0);
    }
    const samePosition = !query.includes('part_index = ?');
    const expected = samePosition
      ? {
          id: values[5],
          rank: this.state.last_message_rank,
          part: this.state.part_index,
          revision: values[6],
          storage: values[7],
          snapshot: values[8],
        }
      : {
          id: values[6],
          rank: values[7],
          part: values[8],
          revision: values[9],
          storage: values[10],
          snapshot: values[11],
        };
    if (
      expected.id !== this.state.id ||
      expected.rank !== this.state.last_message_rank ||
      expected.part !== this.state.part_index ||
      expected.revision !== this.state.transcript_revision ||
      expected.storage !== this.state.storage_key ||
      expected.snapshot !== this.state.snapshot_key
    ) {
      return changed(0);
    }
    this.state.storage_key = (values[0] as string | null) ?? this.state.storage_key;
    this.state.part_index = samePosition ? this.state.part_index : (values[1] as number);
    this.state.snapshot_key = (values[samePosition ? 1 : 2] as string | null) ?? this.state.snapshot_key;
    this.state.description ??= values[samePosition ? 2 : 3] as string | null;
    this.state.transcript_revision = values[samePosition ? 3 : 4] as number;
    this.state.transcript_digest = values[samePosition ? 4 : 5] as string;
    return changed(1);
  }
}

class RetentionDatabase {
  readonly states: Array<{ id: string; storage_key: string; snapshot_key: string; created_at: number }>;
  readonly gcCandidates: string[] = [];

  constructor(count: number) {
    this.states = Array.from({ length: count }, (_, index) => ({
      id: `state-${index}`,
      storage_key: `message-${index}`,
      snapshot_key: `snapshot-${index}`,
      created_at: index,
    }));
  }

  readonly db = {
    prepare: (query: string) => ({
      bind: (...values: unknown[]) => ({
        first: async () => (query.includes('COUNT(*)') ? { state_count: this.states.length } : null),
        all: async () => {
          if (!query.includes('ORDER BY created_at ASC')) {
            return { results: [] };
          }
          return { results: this.states.slice(0, values[1] as number).map((state) => ({ ...state })) };
        },
        run: async () => {
          if (query.startsWith('DELETE FROM chat_message_states')) {
            const index = this.states.findIndex((state) => state.id === values[0]);
            if (index === -1) {
              return changed(0);
            }
            this.states.splice(index, 1);
            return changed(1);
          }
          if (query.includes('INSERT INTO object_gc_candidates')) {
            this.gcCandidates.push(values[0] as string);
            return changed(1);
          }
          return changed(0);
        },
      }),
    }),
    batch: async (statements: D1PreparedStatement[]) =>
      Promise.all(statements.map((statement) => statement.run())) as Promise<D1Result<unknown>[]>,
  } as unknown as D1Database;
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
      const activeOnly = query.includes('initial_id = ? AND is_deleted = 0');
      const exists = this.chats.some(
        (candidate) => candidate.initial_id === initialId && (!activeOnly || candidate.is_deleted === 0),
      );
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

class CloneAuthorizationDatabase {
  authorizationActive = true;
  parentActive = true;
  revokeBeforeBatch = false;
  chatCreated = false;
  readonly preparedQueries: string[] = [];

  readonly db = {
    prepare: (query: string) => {
      this.preparedQueries.push(query);
      return {
        bind: (...values: unknown[]) => ({
          query,
          values,
          run: async () => this.run(query),
        }),
      };
    },
    batch: async (statements: Array<{ run(): Promise<ReturnType<typeof changed>> }>) => {
      if (this.revokeBeforeBatch) {
        this.authorizationActive = false;
        this.revokeBeforeBatch = false;
      }
      const results = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      return results;
    },
  } as unknown as D1Database;

  private run(query: string) {
    if (query.includes('INSERT INTO chats')) {
      if (!this.authorizationActive || !this.parentActive) {
        return changed(0);
      }
      this.chatCreated = true;
      return changed(1);
    }
    if (query.includes('INSERT INTO chat_transcripts') || query.includes('INSERT INTO chat_message_states')) {
      return changed(this.chatCreated ? 1 : 0);
    }
    return changed(0);
  }
}

function changed(changes: number) {
  return { success: true, meta: { changes } };
}
