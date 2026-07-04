import { describe, expect, it } from 'vitest';
import { dataAction, initialMessagesAction, storeChatAction, uploadSnapshotAction } from './data.server';

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
        'https://ghostbuild.dev/store_chat?sessionId=session&chatId=chat&lastMessageRank=invalid&partIndex=0',
        { method: 'POST' },
      ),
      env: envWithDataBindings,
    });

    expect(response.status).toBe(400);
  });

  it('requires chat identity in JSON and query requests', async () => {
    const [initialMessagesResponse, uploadResponse] = await Promise.all([
      initialMessagesAction({
        request: jsonRequest('/initial_messages', { sessionId: 'session' }),
        env: envWithDataBindings,
      }),
      uploadSnapshotAction({
        request: new Request('https://ghostbuild.dev/upload_snapshot?sessionId=session', { method: 'POST' }),
        env: envWithDataBindings,
      }),
    ]);

    expect(initialMessagesResponse.status).toBe(400);
    expect(uploadResponse.status).toBe(400);
  });
});

function jsonRequest(path: string, body: unknown) {
  return new Request(`https://ghostbuild.dev${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
