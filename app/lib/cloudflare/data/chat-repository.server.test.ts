import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureInitialChat, updateChatCheckpoint } from './chat-repository.server';
import type { ChatRow, ChatTranscriptRow } from './types';

const transcriptMocks = vi.hoisted(() => ({
  requireChatTranscript: vi.fn(),
}));

vi.mock('./transcript-repository.server', () => ({
  checkpointMatchesIdentity: (
    checkpoint: { agentName: string; generation: number; subchatIndex: number },
    row: ChatTranscriptRow,
  ) =>
    checkpoint.agentName === row.agent_name &&
    checkpoint.generation === row.generation &&
    checkpoint.subchatIndex === row.subchat_index,
  requireChatTranscript: transcriptMocks.requireChatTranscript,
}));

describe('current chat checkpoint persistence', () => {
  beforeEach(() => {
    transcriptMocks.requireChatTranscript.mockReset().mockResolvedValue(transcript());
  });

  it('updates only transcript metadata and the active chat pointer', async () => {
    const database = new ChatRepositoryDatabase();

    await expect(updateChatCheckpoint(database.db, updateArgs())).resolves.toEqual({ accepted: true });

    expect(database.batchStatements).toHaveLength(2);
    expect(database.batchStatements[0].query).toContain('UPDATE chat_transcripts');
    expect(database.batchStatements[0].query).toContain('last_message_rank = ?');
    expect(database.batchStatements[0].query).toContain('chats.creator_id = ?');
    expect(database.batchStatements[1].query).toContain('UPDATE chats');
    expect(database.batchStatements.map((statement) => statement.query).join('\n')).not.toMatch(
      /storage_key|snapshot_key|chat_message_states/,
    );
  });

  it('rejects a stale transcript checkpoint without writing', async () => {
    const database = new ChatRepositoryDatabase();

    await expect(
      updateChatCheckpoint(database.db, updateArgs({ checkpoint: { ...updateArgs().checkpoint, generation: 1 } })),
    ).resolves.toEqual({ accepted: false });
    expect(database.batchStatements).toHaveLength(0);
  });

  it('rejects a checkpoint that moves the catalog position backwards', async () => {
    transcriptMocks.requireChatTranscript.mockResolvedValue(transcript({ last_message_rank: 8, part_index: 3 }));
    const database = new ChatRepositoryDatabase();

    await expect(updateChatCheckpoint(database.db, updateArgs())).resolves.toEqual({ accepted: false });
    expect(database.batchStatements).toHaveLength(0);
  });
});

describe('ensureInitialChat', () => {
  it('creates only the chat catalog row and BuilderAgent transcript identity', async () => {
    const database = new ChatRepositoryDatabase();

    await expect(
      ensureInitialChat(database.db, { id: 'chat-row', creatorId: 'session', initialId: 'chat' }),
    ).resolves.toMatchObject({ id: 'chat-row', created: true });

    expect(database.batchStatements).toHaveLength(2);
    expect(database.batchStatements[0].query).toContain('INSERT INTO chats');
    expect(database.batchStatements[1].query).toContain('INSERT INTO chat_transcripts');
    expect(database.batchStatements.map((statement) => statement.query).join('\n')).not.toContain(
      'chat_message_states',
    );
  });
});

function updateArgs(overrides: Partial<Parameters<typeof updateChatCheckpoint>[1]> = {}) {
  return {
    sessionId: 'session',
    chatId: 'chat',
    lastMessageRank: 5,
    subchatIndex: 0,
    partIndex: 2,
    initialDescription: 'Initial title',
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

function chat(): ChatRow {
  return {
    id: 'chat-row',
    creator_id: 'session',
    initial_id: 'chat',
    description: null,
    timestamp: '2026-08-01T00:00:00.000Z',
    last_subchat_index: 0,
    is_deleted: 0,
  };
}

function transcript(overrides: Partial<ChatTranscriptRow> = {}): ChatTranscriptRow {
  return {
    chat_id: 'chat-row',
    subchat_index: 0,
    generation: 0,
    agent_name: 'chat',
    head_revision: 0,
    head_digest: null,
    head_message_count: 0,
    last_message_rank: -1,
    part_index: -1,
    description: null,
    parent_subchat_index: null,
    parent_generation: null,
    parent_revision: null,
    transition_token: 'transition',
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

class ChatRepositoryDatabase {
  readonly batchStatements: PreparedStatement[] = [];
  readonly db: D1Database;

  constructor() {
    this.db = {
      prepare: (query: string) => new PreparedStatement(query),
      batch: async (statements: D1PreparedStatement[]) => {
        this.batchStatements.push(...(statements as unknown as PreparedStatement[]));
        return statements.map(() => ({ meta: { changes: 1 } })) as D1Result[];
      },
    } as unknown as D1Database;
  }
}

class PreparedStatement {
  values: unknown[] = [];

  constructor(readonly query: string) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.query.includes('FROM chats')) {
      return chat() as T;
    }
    return null;
  }
}
