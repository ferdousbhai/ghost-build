import { describe, expect, it } from 'vitest';
import { dataAction, initialMessagesAction, storeChatAction } from './data.server';
import { GUEST_SESSION_COOKIE } from '~/lib/guest-session';

const envWithDataBindings = {
  DB: {},
  APP_STORAGE: {},
} as Env;

describe('Cloudflare data request validation', () => {
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

  it('rejects guest sessions without the matching cookie', async () => {
    const response = await dataAction({
      request: jsonRequest('/api/data', {
        path: 'messages.initializeChat',
        args: { id: 'chat', sessionId: 'guest_123e4567-e89b-12d3-a456-426614174000' },
      }),
      env: envWithDataBindings,
    });

    expect(response.status).toBe(401);
  });

  it('accepts guest sessions with the matching cookie', async () => {
    const guestSessionId = 'guest_123e4567-e89b-12d3-a456-426614174000';
    const response = await dataAction({
      request: jsonRequest(
        '/api/data',
        {
          path: 'messages.initializeChat',
          args: { id: 'chat', sessionId: guestSessionId },
        },
        { cookie: `${GUEST_SESSION_COOKIE}=${encodeURIComponent(guestSessionId)}` },
      ),
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
        run: async () => ({ success: true }),
        all: async () => ({ results: [] }),
      }),
    }),
    batch: async (statements: D1PreparedStatement[]) =>
      Promise.all(statements.map((statement) => statement.run())) as Promise<D1Result<unknown>[]>,
  };
  return db as unknown as D1Database;
}
