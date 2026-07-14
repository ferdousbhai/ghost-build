import { describe, expect, it, vi } from 'vitest';
import { D1CloudflareCredentialVault } from './cloudflare-credential-vault';

function createDb() {
  const rows = new Map<string, { ciphertext_base64: string; iv_base64: string }>();
  const prepare = vi.fn((sql: string) => ({
    bind: (...values: unknown[]) => ({
      run: async () => {
        if (sql.startsWith('INSERT')) {
          rows.set(values[0] as string, {
            ciphertext_base64: values[1] as string,
            iv_base64: values[2] as string,
          });
        } else if (sql.includes('UPDATE cloudflare_credentials')) {
          rows.set(values[3] as string, {
            ciphertext_base64: values[0] as string,
            iv_base64: values[1] as string,
          });
        }
        return { success: true, meta: { changes: 1 } };
      },
      first: async () => rows.get(values[0] as string) ?? null,
    }),
  }));
  return { db: { prepare } as unknown as D1Database, rows };
}

function encryptionKey(): string {
  return btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
}

describe('D1CloudflareCredentialVault', () => {
  it('stores only authenticated ciphertext and resolves it by opaque handle', async () => {
    const { db, rows } = createDb();
    const vault = new D1CloudflareCredentialVault(db, encryptionKey());
    const handle = await vault.store('cloudflare-secret-token', 123);

    expect(handle).not.toContain('cloudflare-secret-token');
    expect(JSON.stringify(rows.get(handle))).not.toContain('cloudflare-secret-token');
    await expect(vault.resolve(handle)).resolves.toBe('cloudflare-secret-token');
  });

  it('rejects a key that is not 256 bits', async () => {
    const { db } = createDb();
    const vault = new D1CloudflareCredentialVault(db, btoa('too-short'));
    await expect(vault.store('token')).rejects.toThrow('exactly 32 bytes');
  });

  it('refreshes expired OAuth credentials and rotates the encrypted record', async () => {
    const { db, rows } = createDb();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ access_token: 'fresh-access', refresh_token: 'fresh-refresh', expires_in: 3600 }),
      );
    const vault = new D1CloudflareCredentialVault(db, encryptionKey(), {
      clientId: 'client-1',
      clientSecret: 'client-secret',
      request,
    });
    const handle = await vault.storeOAuthCredential({
      accessToken: 'expired-access',
      refreshToken: 'old-refresh',
      expiresAt: 1,
    });
    const before = JSON.stringify(rows.get(handle));

    await expect(vault.resolve(handle)).resolves.toBe('fresh-access');
    expect(request).toHaveBeenCalledWith(
      'https://dash.cloudflare.com/oauth2/token',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: `Basic ${btoa('client-1:client-secret')}` }),
      }),
    );
    expect(request.mock.contexts).toEqual([undefined]);
    expect(JSON.stringify(rows.get(handle))).not.toBe(before);
    expect(JSON.stringify(rows.get(handle))).not.toContain('fresh-access');
  });
});
