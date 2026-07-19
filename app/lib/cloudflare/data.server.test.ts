import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dataAction, initialMessagesAction, storeChatAction } from './data.server';

const getAuthSession = vi.hoisted(() => vi.fn());
vi.mock('~/lib/.server/auth', () => ({ getAuthSession }));

const envWithDataBindings = {
  DB: {},
  APP_STORAGE: {},
} as Env;
const STRONG_SHARE_CODE = 'a'.repeat(32);

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
    getAuthSession.mockResolvedValue({ user: { id: 'session' } });
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

  it('schedules both deferred cleanup queues after authenticated data work without delaying the response', async () => {
    getAuthSession.mockResolvedValue({ user: { id: 'user-1' } });
    const waitUntil = vi.fn();
    const response = await dataAction({
      request: jsonRequest('/api/data', {
        path: 'messages.initializeChat',
        args: { id: 'chat', sessionId: 'user-1' },
      }),
      env: {
        DB: createDbMock(),
        APP_STORAGE: {},
        BuilderAgent: { getByName: vi.fn() },
      } as unknown as Env,
      executionCtx: { waitUntil },
    });

    expect(response.status).toBe(200);
    expect(waitUntil).toHaveBeenCalledOnce();
    await waitUntil.mock.calls[0][0];
  });

  it('allows the public share-description lookup without a session', async () => {
    getAuthSession.mockResolvedValue(null);
    const response = await dataAction({
      request: jsonRequest('/api/data', {
        path: 'share.getShareDescription',
        args: { code: STRONG_SHARE_CODE },
      }),
      env: {
        DB: createDbMock(),
        APP_STORAGE: {},
      } as Env,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: { description: 'Shared project' } });
    expect(getAuthSession).not.toHaveBeenCalled();
  });

  it('rejects oversized chunked JSON before dispatching a public operation', async () => {
    const body = JSON.stringify({
      path: 'share.getShareDescription',
      args: { code: STRONG_SHARE_CODE },
      padding: 'x'.repeat(70 * 1024),
    });
    const request = new Request('https://ghostbuild.dev/api/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body.slice(0, 1024)));
          controller.enqueue(new TextEncoder().encode(body.slice(1024)));
          controller.close();
        },
      }),
      duplex: 'half',
    } as RequestInit);

    const response = await dataAction({ request, env: envWithDataBindings });

    expect(response.status).toBe(413);
    expect(getAuthSession).not.toHaveBeenCalled();
  });

  it('returns not found for an unknown public share instead of an internal error', async () => {
    const response = await dataAction({
      request: jsonRequest('/api/data', {
        path: 'socialShare.getSocialShare',
        args: { code: 'b'.repeat(32) },
      }),
      env: {
        DB: emptyDbMock(),
        APP_STORAGE: {},
      } as Env,
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Invalid share link' });
  });

  it('does not reflect unexpected backend failures through the anonymous share endpoint', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await dataAction({
      request: jsonRequest('/api/data', {
        path: 'share.getShareDescription',
        args: { code: STRONG_SHARE_CODE },
      }),
      env: {
        DB: {
          prepare: () => ({
            bind: () => ({
              first: async () => {
                throw new Error('SECRET_SCHEMA_MARKER: shares.description');
              },
            }),
          }),
        },
        APP_STORAGE: {},
      } as unknown as Env,
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Unknown data error' });
    consoleError.mockRestore();
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
          query.includes('FROM shares')
            ? { description: 'Shared project' }
            : query.includes('SELECT * FROM chats')
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

function emptyDbMock(): D1Database {
  return {
    prepare: () => ({
      bind: () => ({ first: async () => null }),
    }),
  } as unknown as D1Database;
}
