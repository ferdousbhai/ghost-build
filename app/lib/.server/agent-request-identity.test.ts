import { beforeEach, describe, expect, it, vi } from 'vitest';

const getAuthSession = vi.hoisted(() => vi.fn());
const ensureInitialChat = vi.hoisted(() => vi.fn());
const routeAgentRequest = vi.hoisted(() => vi.fn());

vi.mock('./auth', () => ({
  getAuthSession,
}));
vi.mock('~/lib/cloudflare/data/chat-repository.server', () => ({ ensureInitialChat }));
vi.mock('agents', () => ({ routeAgentRequest }));

import {
  authorizeAgentRequest,
  resolveAgentRequestIdentity,
  routeAuthorizedAgentRequest,
} from './agent-request-identity';

function envWithChats(chats: Array<{ creatorId: string; isDeleted?: number }> = []) {
  return {
    DB: {
      prepare: vi.fn(() => ({
        bind: vi.fn((ownerId: string) => ({
          first: vi.fn(async () => ({
            match_count: chats.length,
            active_match_count: chats.filter((chat) => !chat.isDeleted).length,
            has_owner_conflict: chats.some((chat) => chat.creatorId !== ownerId) ? 1 : 0,
          })),
        })),
      })),
    },
  } as unknown as Env;
}

describe('Agent request identity', () => {
  beforeEach(() => {
    getAuthSession.mockReset();
    ensureInitialChat.mockReset();
    ensureInitialChat.mockResolvedValue({ id: 'claimed-chat', created: true });
    routeAgentRequest.mockReset();
    routeAgentRequest.mockResolvedValue(new Response('routed'));
  });

  it.each(['/agents/builder-agent/chat', '//agents/builder-agent/chat', '///agents//builder-agent/chat'])(
    'authorizes every empty-segment spelling that PartyServer treats as the same route: %s',
    async (pathname) => {
      getAuthSession.mockResolvedValue({ user: { id: 'owner-1' } });
      const database = databaseReturning({ match_count: 1, active_match_count: 1, has_owner_conflict: 0 });
      const env = { DB: database.db } as Env;
      const request = new Request(`https://ghostbuild.dev${pathname}`);

      await expect(routeAuthorizedAgentRequest(request, env)).resolves.toHaveProperty('status', 200);
      expect(database.values).toEqual(['owner-1', 'chat', 'chat']);
      expect(routeAgentRequest).toHaveBeenCalledWith(request, env, {
        props: { ownerId: 'owner-1', userId: 'owner-1' },
      });
    },
  );

  it.each([
    '/agents',
    '/agents/',
    '/agents/deployment-sandbox/chat',
    '//agents//deployment-sandbox//chat',
    '/agents/container-proxy/chat',
    '/agents/deployment-workflow/chat',
    '/agents/builder-agent-extra/chat',
    '/agents/BuilderAgent/chat',
    '/agents/%62uilder-agent/chat',
    '/agents/%64eployment-sandbox/chat',
    '/agents/builder-agent',
  ])('rejects a non-BuilderAgent namespace or missing name before PartyServer routing: %s', async (pathname) => {
    const result = await routeAuthorizedAgentRequest(new Request(`https://ghostbuild.dev${pathname}`), {} as Env);

    expect(result?.status).toBe(404);
    expect(getAuthSession).not.toHaveBeenCalled();
    expect(routeAgentRequest).not.toHaveBeenCalled();
  });

  it.each([
    '/agents/builder-agent/%',
    '/agents/builder-agent/%C3%28',
    '/agents/builder-agent/%ED%A0%80',
    '/agents/builder-agent/%63hat',
    '/agents/builder-agent/%2f',
    '/agents/builder-agent/%c3%a9',
  ])('rejects a malformed or noncanonical encoded BuilderAgent name before authorization: %s', async (pathname) => {
    const result = await routeAuthorizedAgentRequest(new Request(`https://ghostbuild.dev${pathname}`), {} as Env);

    expect(result?.status).toBe(404);
    expect(getAuthSession).not.toHaveBeenCalled();
    expect(routeAgentRequest).not.toHaveBeenCalled();
  });

  it.each(['a'.repeat(513), '%C3%A9'.repeat(86)])(
    'rejects an overlong canonical BuilderAgent wire name before authorization',
    async (encodedName) => {
      const result = await routeAuthorizedAgentRequest(
        new Request(`https://ghostbuild.dev/agents/builder-agent/${encodedName}`),
        {} as Env,
      );

      expect(result?.status).toBe(404);
      expect(getAuthSession).not.toHaveBeenCalled();
      expect(routeAgentRequest).not.toHaveBeenCalled();
    },
  );

  it('uses the identical canonical encoded BuilderAgent name for authorization and PartyServer routing', async () => {
    getAuthSession.mockResolvedValue({ user: { id: 'owner-1' } });
    const database = databaseReturning({ match_count: 1, active_match_count: 1, has_owner_conflict: 0 });
    const env = { DB: database.db } as Env;
    const request = new Request('https://ghostbuild.dev//agents//builder-agent/%C3%A9');

    const response = await routeAuthorizedAgentRequest(request, env);

    expect(response?.status).toBe(200);
    expect(database.values).toEqual(['owner-1', '%C3%A9', '%C3%A9']);
    expect(routeAgentRequest).toHaveBeenCalledWith(request, env, {
      props: { ownerId: 'owner-1', userId: 'owner-1' },
    });
    const routedRequest = routeAgentRequest.mock.calls[0]?.[0] as Request;
    const routedName = new URL(routedRequest.url).pathname.split('/').filter(Boolean)[2];
    expect(routedName).toBe(database.values[1]);
  });

  it('leaves non-Agent requests for the application router', async () => {
    await expect(
      routeAuthorizedAgentRequest(new Request('https://ghostbuild.dev/api/health'), {} as Env),
    ).resolves.toBe(null);
    expect(getAuthSession).not.toHaveBeenCalled();
    expect(routeAgentRequest).not.toHaveBeenCalled();
  });

  it('does not route a canonical BuilderAgent request without a server session', async () => {
    getAuthSession.mockResolvedValue(null);

    const response = await routeAuthorizedAgentRequest(
      new Request('https://ghostbuild.dev/agents/builder-agent/chat'),
      envWithChats(),
    );

    expect(response?.status).toBe(401);
    expect(routeAgentRequest).not.toHaveBeenCalled();
  });

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
      'private-chat',
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
        'my-chat',
      ),
    ).resolves.toEqual({
      identity: { ownerId: 'owner', userId: 'owner' },
    });
  });

  it('atomically claims an unprovisioned BuilderAgent name for the authenticated owner', async () => {
    getAuthSession.mockResolvedValue({ user: { id: 'owner' } });
    const agentName = 'e59066e3-07a0-4757-aead-a736431b9218';
    await expect(
      authorizeAgentRequest(
        new Request(`https://ghostbuild.dev/agents/builder-agent/${agentName}`),
        envWithChats(),
        agentName,
      ),
    ).resolves.toEqual({ identity: { ownerId: 'owner', userId: 'owner' } });

    expect(ensureInitialChat).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ creatorId: 'owner', initialId: agentName }),
    );
  });

  it.each(['legacy-name', 'old--transcript-2-1'])(
    'does not provision an unrecognized non-root Agent name: %s',
    async (agentName) => {
      getAuthSession.mockResolvedValue({ user: { id: 'owner' } });

      const result = await authorizeAgentRequest(
        new Request(`https://ghostbuild.dev/agents/builder-agent/${agentName}`),
        envWithChats(),
        agentName,
      );

      expect('response' in result && result.response.status).toBe(404);
      expect(ensureInitialChat).not.toHaveBeenCalled();
    },
  );

  it('still routes an existing legacy Agent name', async () => {
    getAuthSession.mockResolvedValue({ user: { id: 'owner' } });

    await expect(
      authorizeAgentRequest(
        new Request('https://ghostbuild.dev/agents/builder-agent/legacy-name'),
        envWithChats([{ creatorId: 'owner' }]),
        'legacy-name',
      ),
    ).resolves.toEqual({ identity: { ownerId: 'owner', userId: 'owner' } });
    expect(ensureInitialChat).not.toHaveBeenCalled();
  });

  it('classifies a raced root Agent collision as not found instead of surfacing the insert error', async () => {
    getAuthSession.mockResolvedValue({ user: { id: 'owner' } });
    ensureInitialChat.mockRejectedValue(new Error('UNIQUE constraint failed: chat_transcripts.agent_name'));
    const agentName = 'e59066e3-07a0-4757-aead-a736431b9218';
    const prepared: Array<{ query: string; values: unknown[] }> = [];
    const db = {
      prepare: vi.fn((query: string) => ({
        bind: vi.fn((...values: unknown[]) => {
          prepared.push({ query, values });
          return {
            first: vi.fn(async () =>
              query.includes('COUNT(*)')
                ? { match_count: 0, active_match_count: 0, has_owner_conflict: null }
                : { creator_id: 'other-owner' },
            ),
          };
        }),
      })),
    } as unknown as D1Database;

    const result = await authorizeAgentRequest(
      new Request(`https://ghostbuild.dev/agents/builder-agent/${agentName}`),
      { DB: db } as Env,
      agentName,
    );

    expect('response' in result && result.response.status).toBe(404);
    expect(prepared[1].query).toContain('LEFT JOIN chat_transcripts');
    expect(prepared[1].values).toEqual([agentName, agentName]);
  });

  it('adopts a raced root Agent claim when the active transcript belongs to the session', async () => {
    getAuthSession.mockResolvedValue({ user: { id: 'owner' } });
    ensureInitialChat.mockRejectedValue(new Error('UNIQUE constraint failed: chat_transcripts.agent_name'));
    const agentName = 'e59066e3-07a0-4757-aead-a736431b9218';
    const db = {
      prepare: vi.fn((query: string) => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () =>
            query.includes('COUNT(*)')
              ? { match_count: 0, active_match_count: 0, has_owner_conflict: null }
              : { creator_id: 'owner' },
          ),
        })),
      })),
    } as unknown as D1Database;

    await expect(
      authorizeAgentRequest(
        new Request(`https://ghostbuild.dev/agents/builder-agent/${agentName}`),
        { DB: db } as Env,
        agentName,
      ),
    ).resolves.toEqual({ identity: { ownerId: 'owner', userId: 'owner' } });
  });

  it('does not route a deleted chat to its durable BuilderAgent', async () => {
    getAuthSession.mockResolvedValue({ user: { id: 'owner' } });
    const result = await authorizeAgentRequest(
      new Request('https://ghostbuild.dev/agents/builder-agent/deleted-chat'),
      envWithChats([{ creatorId: 'owner', isDeleted: 1 }]),
      'deleted-chat',
    );
    expect('response' in result).toBe(true);
    if ('response' in result) {
      expect(result.response.status).toBe(404);
    }
  });

  it('allows the owner to retry after replacing a discarded empty chat', async () => {
    getAuthSession.mockResolvedValue({ user: { id: 'owner' } });
    await expect(
      authorizeAgentRequest(
        new Request('https://ghostbuild.dev/agents/builder-agent/retried-chat'),
        envWithChats([{ creatorId: 'owner', isDeleted: 1 }, { creatorId: 'owner' }]),
        'retried-chat',
      ),
    ).resolves.toEqual({
      identity: { ownerId: 'owner', userId: 'owner' },
    });
  });

  it('denies an agent name when any matching chat is deleted or belongs to another owner', async () => {
    getAuthSession.mockResolvedValue({ user: { id: 'owner' } });
    const result = await authorizeAgentRequest(
      new Request('https://ghostbuild.dev/agents/builder-agent/colliding-chat'),
      envWithChats([{ creatorId: 'owner' }, { creatorId: 'attacker' }]),
      'colliding-chat',
    );
    expect('response' in result && result.response.status).toBe(404);
  });

  it('authorizes a generation-specific transcript owned by the session', async () => {
    getAuthSession.mockResolvedValue({ user: { id: 'owner-1' } });
    const database = databaseReturning({ match_count: 1, active_match_count: 1, has_owner_conflict: 0 });

    const result = await authorizeAgentRequest(
      new Request('https://ghostbuild.dev/agents/builder-agent/chat--transcript-2-1'),
      { DB: database.db } as Env,
      'chat--transcript-2-1',
    );

    expect(result).toEqual({
      identity: { ownerId: 'owner-1', userId: 'owner-1' },
    });
    expect(database.query).toContain('LEFT JOIN chat_transcripts');
    expect(database.values).toEqual(['owner-1', 'chat--transcript-2-1', 'chat--transcript-2-1']);
  });
});

function databaseReturning(row: { match_count: number; active_match_count: number; has_owner_conflict: number }) {
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
