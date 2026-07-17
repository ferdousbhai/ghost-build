import { describe, expect, it, vi } from 'vitest';
import { createSubchat, rewindChat, setGeneratedDescriptionIfMissing } from './chat-service.server';
import type { ChatMessageStateRow, ChatRow, ChatTranscriptRow } from './types';

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

describe('transcript generation transitions', () => {
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
  });

  it('rotates the agent generation and ties every rewind write to one transition token', async () => {
    const database = new ChatServiceDatabase();

    await expect(
      rewindChat(database.db, { sessionId: 'user-1', chatId: 'chat', subchatIndex: 2, lastMessageRank: 5 }),
    ).resolves.toBeNull();

    const [transcriptUpdate, stateInsert, chatUpdate] = database.batchStatements;
    expect(transcriptUpdate.query).toContain('SET generation = ?');
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
});

type BoundStatement = {
  query: string;
  values: unknown[];
  run: () => Promise<D1Result>;
};

class ChatServiceDatabase {
  readonly batchStatements: BoundStatement[] = [];

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

  constructor(private readonly batchChanges = [1, 1, 1]) {}

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
          first: async () => this.first(query),
        };
      },
    }),
    batch: async (statements: BoundStatement[]) => {
      this.batchStatements.push(...statements);
      return statements.map(
        (_statement, index) => ({ success: true, meta: { changes: this.batchChanges[index] ?? 1 } }) as D1Result,
      );
    },
  } as unknown as D1Database;

  private first(query: string): ChatRow | ChatTranscriptRow | ChatMessageStateRow | null {
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
}
