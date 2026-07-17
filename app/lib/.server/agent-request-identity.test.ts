import { beforeEach, describe, expect, it, vi } from 'vitest';

const getAuthSession = vi.hoisted(() => vi.fn());

vi.mock('./auth', () => ({
  getAuthSession,
}));

import { authorizeAgentRequest, resolveAgentRequestIdentity } from './agent-request-identity';

function envWithChats(chats: Array<{ creatorId: string; isDeleted?: number }> = []) {
  return {
    DB: {
      prepare: vi.fn(() => ({
        bind: vi.fn((ownerId: string) => ({
          first: vi.fn(async () => ({
            match_count: chats.length,
            has_conflict: chats.some((chat) => chat.isDeleted || chat.creatorId !== ownerId) ? 1 : 0,
          })),
        })),
      })),
    },
  } as unknown as Env;
}

describe('Agent request identity', () => {
  beforeEach(() => getAuthSession.mockReset());

  it('derives signed-in billing identity from the server session', async () => {
    getAuthSession.mockResolvedValue({ user: { id: 'user-1' } });
    await expect(
      resolveAgentRequestIdentity(new Request('https://ghostbuild.dev/agents/builder-agent/chat-1'), envWithChats()),
    ).resolves.toEqual({ ownerId: 'user-1', userId: 'user-1' });
  });

  it('rejects requests without a Cloudflare-backed session', async () => {
    getAuthSession.mockResolvedValue(null);
    await expect(
      resolveAgentRequestIdentity(new Request('https://ghostbuild.dev/agents/builder-agent/chat-1'), envWithChats()),
    ).resolves.toBeNull();
  });

  it("does not reveal or route another user's BuilderAgent", async () => {
    getAuthSession.mockResolvedValue({ user: { id: 'attacker' } });
    const result = await authorizeAgentRequest(
      new Request('https://ghostbuild.dev/agents/builder-agent/private-chat'),
      envWithChats([{ creatorId: 'owner' }]),
    );
    expect('response' in result).toBe(true);
    if ('response' in result) {
      expect(result.response.status).toBe(404);
    }
  });

  it('allows the owner and passes only server-derived props', async () => {
    getAuthSession.mockResolvedValue({ user: { id: 'owner' } });
    await expect(
      authorizeAgentRequest(
        new Request('https://ghostbuild.dev/agents/builder-agent/my-chat'),
        envWithChats([{ creatorId: 'owner' }]),
      ),
    ).resolves.toEqual({
      identity: { ownerId: 'owner', userId: 'owner' },
    });
  });

  it('does not route a deleted chat to its durable BuilderAgent', async () => {
    getAuthSession.mockResolvedValue({ user: { id: 'owner' } });
    const result = await authorizeAgentRequest(
      new Request('https://ghostbuild.dev/agents/builder-agent/deleted-chat'),
      envWithChats([{ creatorId: 'owner', isDeleted: 1 }]),
    );
    expect('response' in result).toBe(true);
    if ('response' in result) {
      expect(result.response.status).toBe(404);
    }
  });

  it('denies an agent name when any matching chat is deleted or belongs to another owner', async () => {
    getAuthSession.mockResolvedValue({ user: { id: 'owner' } });
    const result = await authorizeAgentRequest(
      new Request('https://ghostbuild.dev/agents/builder-agent/colliding-chat'),
      envWithChats([{ creatorId: 'owner' }, { creatorId: 'attacker' }]),
    );
    expect('response' in result && result.response.status).toBe(404);
  });

  it('authorizes a generation-specific transcript owned by the session', async () => {
    getAuthSession.mockResolvedValue({ user: { id: 'owner-1' } });
    const database = databaseReturning({ match_count: 1, has_conflict: 0 });

    const result = await authorizeAgentRequest(
      new Request('https://ghostbuild.dev/agents/builder-agent/chat--transcript-2-1'),
      { DB: database.db } as Env,
    );

    expect(result).toEqual({
      identity: { ownerId: 'owner-1', userId: 'owner-1' },
    });
    expect(database.query).toContain('LEFT JOIN chat_transcripts');
    expect(database.values).toEqual(['owner-1', 'chat--transcript-2-1', 'chat--transcript-2-1']);
  });
});

function databaseReturning(row: { match_count: number; has_conflict: number }) {
  const state = { query: '', values: [] as unknown[] };
  return {
    get query() {
      return state.query;
    },
    get values() {
      return state.values;
    },
    db: {
      prepare(query: string) {
        state.query = query;
        return {
          bind(...values: unknown[]) {
            state.values = values;
            return { first: async () => row };
          },
        };
      },
    } as unknown as D1Database,
  };
}
