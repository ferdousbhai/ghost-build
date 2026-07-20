import { describe, expect, it, vi } from 'vitest';
import { runAccountWorkersAi } from './account-workers-ai';

function dbWithConnection(overrides: Partial<Record<string, unknown>> = {}) {
  const row = {
    id: 'connection-1',
    user_id: 'user-1',
    account_id: 'account-123',
    account_name: 'Example account',
    status: 'active',
    credential_handle: 'credential-handle-1',
    granted_scopes_json: '["workers_ai"]',
    ai_billing_enabled: 1,
    connected_at: 1,
    updated_at: 2,
    ...overrides,
  };
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({ first: vi.fn(async () => row) })),
    })),
  } as unknown as D1Database;
}

describe('runAccountWorkersAi', () => {
  it('runs inference against the connected user account with an opaque credential', async () => {
    let requestedUrl = '';
    let requestedAuthorization: string | null = null;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedAuthorization = new Headers(init?.headers).get('authorization');
      return Response.json({ success: true, result: { response: 'ok' } });
    });
    const resolve = vi.fn(async () => 'private-token');

    const response = await runAccountWorkersAi({
      db: dbWithConnection(),
      connectionId: 'connection-1',
      credentialResolver: { resolve },
      model: '@cf/zai-org/glm-5.2',
      input: { messages: [{ role: 'user', content: 'hello' }] },
      fetch,
    });

    expect(response.ok).toBe(true);
    expect(resolve).toHaveBeenCalledWith('credential-handle-1');
    expect(fetch).toHaveBeenCalledOnce();
    expect(requestedUrl).toBe('https://api.cloudflare.com/client/v4/accounts/account-123/ai/run/%40cf/zai-org/glm-5.2');
    expect(requestedAuthorization).toBe('Bearer private-token');
  });

  it('fails before resolving credentials when account billing is disabled', async () => {
    const resolve = vi.fn(async () => 'private-token');
    await expect(
      runAccountWorkersAi({
        db: dbWithConnection({ ai_billing_enabled: 0 }),
        connectionId: 'connection-1',
        credentialResolver: { resolve },
        model: '@cf/zai-org/glm-5.2',
        input: {},
      }),
    ).rejects.toThrow('Workers AI billing is not enabled');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('rejects non-Cloudflare models', async () => {
    await expect(
      runAccountWorkersAi({
        db: dbWithConnection(),
        connectionId: 'connection-1',
        credentialResolver: { resolve: async () => 'private-token' },
        model: 'openai/gpt-5',
        input: {},
      }),
    ).rejects.toThrow('only supports Cloudflare-hosted Workers AI models');
  });
});
