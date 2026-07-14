import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSession = vi.fn();

vi.mock('./auth', () => ({
  getAuth: () => ({ api: { getSession } }),
}));

import { authorizeAgentRequest, resolveAgentRequestIdentity } from './agent-request-identity';

function envWithOwner(creatorId: string | null) {
  return {
    DB: {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => (creatorId ? { creator_id: creatorId } : null)),
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
      resolveAgentRequestIdentity(
        new Request('https://ghostbuild.dev/agents/builder-agent/chat-1'),
        envWithOwner(null),
      ),
    ).resolves.toEqual({ billingSubjectKey: 'user:user-1', ownerId: 'user-1', userId: 'user-1' });
  });

  it('derives anonymous billing identity only from a valid guest cookie', async () => {
    getSession.mockResolvedValue(null);
    const guestId = 'guest_12345678-1234-4123-8123-123456789abc';
    const request = new Request('https://ghostbuild.dev/agents/builder-agent/chat-1', {
      headers: { cookie: `ghostbuild_guest_session=${guestId}` },
    });
    await expect(resolveAgentRequestIdentity(request, envWithOwner(null))).resolves.toEqual({
      billingSubjectKey: `guest:${guestId}`,
      ownerId: guestId,
    });
  });

  it("does not reveal or route another user's BuilderAgent", async () => {
    getSession.mockResolvedValue({ user: { id: 'attacker' } });
    const result = await authorizeAgentRequest(
      new Request('https://ghostbuild.dev/agents/builder-agent/private-chat'),
      envWithOwner('owner'),
    );
    expect('response' in result).toBe(true);
    if ('response' in result) {
      expect(result.response.status).toBe(404);
    }
  });

  it('allows the owner and passes only server-derived props', async () => {
    getSession.mockResolvedValue({ user: { id: 'owner' } });
    await expect(
      authorizeAgentRequest(new Request('https://ghostbuild.dev/agents/builder-agent/my-chat'), envWithOwner('owner')),
    ).resolves.toEqual({
      identity: { billingSubjectKey: 'user:owner', ownerId: 'owner', userId: 'owner' },
    });
  });
});
