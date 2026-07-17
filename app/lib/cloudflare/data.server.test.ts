import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dataAction, initialMessagesAction, storeChatAction } from './data.server';

const getAuthSession = vi.hoisted(() => vi.fn());
vi.mock('~/lib/.server/auth', () => ({ getAuthSession }));

const envWithDataBindings = {
  DB: {},
  APP_STORAGE: {},
} as Env;

describe('Cloudflare data request validation', () => {
  beforeEach(() => getAuthSession.mockReset());
  it('requires operation arguments', async () => {
    const response = await dataAction({
      request: jsonRequest('/api/data', { path: 'messages.initializeChat' }),
      env: {} as Env,
    });

    expect(response.status).toBe(400);
  });

  it('rejects unsupported operations', async () => {
    const response = await dataAction({
      request: jsonRequest('/api/data', { path: 'unsupported.operation', args: {} }),
      env: {} as Env,
    });

    expect(response.status).toBe(400);
  });

  it('rejects invalid store-chat indexes', async () => {
    const response = await storeChatAction({
      request: new Request(
        'https://ghostbuild.dev/api/chats/store?sessionId=session&chatId=chat&lastMessageRank=invalid&partIndex=0',
        { method: 'POST' },
      ),
      env: envWithDataBindings,
    });

    expect(response.status).toBe(400);
  });

  it('requires chat identity in JSON requests', async () => {
    const response = await initialMessagesAction({
      request: jsonRequest('/api/chats/messages', { sessionId: 'session' }),
      env: envWithDataBindings,
    });

    expect(response.status).toBe(400);
  });

  it('rejects operations without a Cloudflare-backed session', async () => {
    getAuthSession.mockResolvedValue(null);
    const response = await dataAction({
      request: jsonRequest('/api/data', {
        path: 'messages.initializeChat',
        args: { id: 'chat', sessionId: 'user-1' },
      }),
      env: envWithDataBindings,
    });

    expect(response.status).toBe(401);
  });

  it('accepts operations owned by the Cloudflare-backed session', async () => {
    getAuthSession.mockResolvedValue({ user: { id: 'user-1' } });
    const response = await dataAction({
      request: jsonRequest('/api/data', {
        path: 'messages.initializeChat',
        args: { id: 'chat', sessionId: 'user-1' },
      }),
      env: {
        DB: createDbMock(),
        APP_STORAGE: {},
      } as Env,
    });

    expect(response.status).toBe(200);
  });
});

function jsonRequest(path: string, body: unknown, headers: HeadersInit = {}) {
  return new Request(`https://ghostbuild.dev${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function createDbMock() {
  const db = {
    prepare: (query: string) => ({
      bind: (...values: unknown[]) => ({
        first: async () =>
          query.includes('SELECT * FROM chats')
            ? {
                id: 'chat-row',
                creator_id: values[0],
                initial_id: values[1],
                is_deleted: 0,
              }
            : null,
        run: async () => ({ success: true, meta: { changes: query.includes('INSERT INTO chats') ? 1 : 0 } }),
        all: async () => ({ results: [] }),
      }),
    }),
    batch: async (statements: D1PreparedStatement[]) =>
      Promise.all(statements.map((statement) => statement.run())) as Promise<D1Result<unknown>[]>,
  };
  return db as unknown as D1Database;
}
