import { describe, expect, it } from 'vitest';
import { ensureInitialChat, markChatStarted } from './chat-repository.server';
import type { ChatRow } from './types';

describe('chat catalog visibility', () => {
  it('records only that an owner-scoped Agent accepted content', async () => {
    const database = new ChatRepositoryDatabase();

    await markChatStarted(database.db, {
      sessionId: 'session',
      chatId: 'chat',
      agentName: 'chat',
    });

    expect(database.runStatements).toHaveLength(1);
    expect(database.runStatements[0].query).toContain('SET has_messages = 1');
    expect(database.runStatements[0].query).toContain('chat_transcripts.agent_name = ?');
    expect(database.runStatements[0].values).toEqual(['session', 'chat', 'chat']);
    expect(database.runStatements[0].query).not.toMatch(/head_revision|head_digest|message_rank|part_index/);
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
    expect(database.batchStatements.map((statement) => statement.query).join('\n')).not.toMatch(
      /head_revision|head_digest|message_rank|part_index/,
    );
  });
});

function chat(): ChatRow {
  return {
    id: 'chat-row',
    creator_id: 'session',
    initial_id: 'chat',
    description: null,
    timestamp: '2026-08-01T00:00:00.000Z',
    last_subchat_index: 0,
    has_messages: 0,
    is_deleted: 0,
  };
}

class ChatRepositoryDatabase {
  readonly batchStatements: PreparedStatement[] = [];
  readonly runStatements: PreparedStatement[] = [];
  readonly db: D1Database;

  constructor() {
    this.db = {
      prepare: (query: string) => new PreparedStatement(query, this.runStatements),
      batch: async (statements: D1PreparedStatement[]) => {
        this.batchStatements.push(...(statements as unknown as PreparedStatement[]));
        return statements.map(() => ({ meta: { changes: 1 } })) as D1Result[];
      },
    } as unknown as D1Database;
  }
}

class PreparedStatement {
  values: unknown[] = [];

  constructor(
    readonly query: string,
    private readonly runStatements: PreparedStatement[] = [],
  ) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return this.query.includes('FROM chats') ? (chat() as T) : null;
  }

  async run(): Promise<D1Result> {
    this.runStatements.push(this);
    return { meta: { changes: 1 } } as D1Result;
  }
}
