import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSession = vi.fn();

vi.mock('./auth', () => ({
  getAuth: () => ({ api: { getSession } }),
}));

import { authorizeAgentRequest, resolveAgentRequestIdentity } from './agent-request-identity';

function envWithChats(chats: Array<{ creatorId: string; isDeleted?: number }> = []) {
  return {
    BETTER_AUTH_SECRET: 'test-auth-secret',
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
  beforeEach(() => getSession.mockReset());

  it('derives signed-in billing identity from the server session', async () => {
    getSession.mockResolvedValue({ user: { id: 'user-1' } });
    await expect(
      resolveAgentRequestIdentity(new Request('https://ghostbuild.dev/agents/builder-agent/chat-1'), envWithChats()),
    ).resolves.toEqual({ billingSubjectKey: 'user:user-1', ownerId: 'user-1', userId: 'user-1' });
  });

  it('derives anonymous billing identity only from a valid guest cookie', async () => {
    getSession.mockResolvedValue(null);
    const guestId = 'guest_12345678-1234-4123-8123-123456789abc';
    const request = new Request('https://ghostbuild.dev/agents/builder-agent/chat-1', {
      headers: { cookie: `ghostbuild_guest_session=${guestId}`, 'CF-Connecting-IP': '203.0.113.10' },
    });
    const identity = await resolveAgentRequestIdentity(request, envWithChats());
    expect(identity).toMatchObject({ ownerId: guestId });
    expect(identity?.billingSubjectKey).toMatch(/^guest:[0-9a-f]{64}$/);
    expect(identity?.billingSubjectKey).not.toContain(guestId);
  });

  it('does not grant a fresh allowance when a client rotates its guest cookie', async () => {
    getSession.mockResolvedValue(null);
    const request = (guestId: string) =>
      new Request('https://ghostbuild.dev/agents/builder-agent/chat-1', {
        headers: { cookie: `ghostbuild_guest_session=${guestId}`, 'CF-Connecting-IP': '203.0.113.10' },
      });
    const first = await resolveAgentRequestIdentity(
      request('guest_12345678-1234-4123-8123-123456789abc'),
      envWithChats(),
    );
    const second = await resolveAgentRequestIdentity(
      request('guest_abcdefab-cdef-4abc-8def-abcdefabcdef'),
      envWithChats(),
    );
    expect(first?.billingSubjectKey).toBe(second?.billingSubjectKey);
    expect(first?.ownerId).not.toBe(second?.ownerId);
  });

  it("does not reveal or route another user's BuilderAgent", async () => {
    getSession.mockResolvedValue({ user: { id: 'attacker' } });
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
    getSession.mockResolvedValue({ user: { id: 'owner' } });
    await expect(
      authorizeAgentRequest(
        new Request('https://ghostbuild.dev/agents/builder-agent/my-chat'),
        envWithChats([{ creatorId: 'owner' }]),
      ),
    ).resolves.toEqual({
      identity: { billingSubjectKey: 'user:owner', ownerId: 'owner', userId: 'owner' },
    });
  });

  it('does not route a deleted chat to its durable BuilderAgent', async () => {
    getSession.mockResolvedValue({ user: { id: 'owner' } });
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
    getSession.mockResolvedValue({ user: { id: 'owner' } });
    const result = await authorizeAgentRequest(
      new Request('https://ghostbuild.dev/agents/builder-agent/colliding-chat'),
      envWithChats([{ creatorId: 'owner' }, { creatorId: 'attacker' }]),
    );
    expect('response' in result && result.response.status).toBe(404);
  });
});
