import type { CloudflareCredentialResolver } from './account-workers-ai';

const AES_GCM_IV_BYTES = 12;
const AES_256_KEY_BYTES = 32;

type CredentialRow = {
  ciphertext_base64: string;
  iv_base64: string;
};

export class D1CloudflareCredentialVault implements CloudflareCredentialResolver {
  constructor(
    private readonly db: D1Database,
    private readonly encryptionKeyBase64: string,
    private readonly oauth?: { clientId: string; clientSecret: string; request?: typeof fetch },
  ) {}

  static fromEnv(env: Env): D1CloudflareCredentialVault {
    if (!env.CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY) {
      throw new Error('Cloudflare credential encryption is not configured.');
    }
    const oauth =
      env.CLOUDFLARE_OAUTH_CLIENT_ID && env.CLOUDFLARE_OAUTH_CLIENT_SECRET
        ? { clientId: env.CLOUDFLARE_OAUTH_CLIENT_ID, clientSecret: env.CLOUDFLARE_OAUTH_CLIENT_SECRET }
        : undefined;
    return new D1CloudflareCredentialVault(env.DB, env.CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY, oauth);
  }

  async store(token: string, now = Date.now()): Promise<string> {
    if (!token) {
      throw new Error('Cannot store an empty Cloudflare credential.');
    }
    const encrypted = await this.encrypt(token);
    const handle = crypto.randomUUID();
    await this.db
      .prepare(
        `INSERT INTO cloudflare_credentials
          (handle, ciphertext_base64, iv_base64, key_version, created_at)
         VALUES (?, ?, ?, 1, ?)`,
      )
      .bind(handle, encrypted.ciphertextBase64, encrypted.ivBase64, now)
      .run();
    return handle;
  }

  async storeOAuthCredential(
    credential: { accessToken: string; refreshToken: string; expiresAt: number },
    now = Date.now(),
  ): Promise<string> {
    return this.store(JSON.stringify({ version: 1, ...credential }), now);
  }

  async resolve(credentialHandle: string): Promise<string> {
    const row = await this.db
      .prepare(`SELECT ciphertext_base64, iv_base64 FROM cloudflare_credentials WHERE handle = ?`)
      .bind(credentialHandle)
      .first<CredentialRow>();
    if (!row) {
      throw new Error('Cloudflare credential is unavailable.');
    }
    const key = await importEncryptionKey(this.encryptionKeyBase64, ['decrypt']);
    let plaintext: ArrayBuffer;
    try {
      plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: base64ToBytes(row.iv_base64) },
        key,
        base64ToBytes(row.ciphertext_base64),
      );
    } catch {
      throw new Error('Cloudflare credential could not be decrypted.');
    }
    const value = new TextDecoder().decode(plaintext);
    const oauthCredential = parseOAuthCredential(value);
    if (!oauthCredential) {
      return value;
    }
    if (oauthCredential.expiresAt > Date.now() + 60_000) {
      return oauthCredential.accessToken;
    }
    return this.refreshOAuthCredential(credentialHandle, oauthCredential);
  }

  async delete(credentialHandle: string): Promise<void> {
    await this.db.prepare('DELETE FROM cloudflare_credentials WHERE handle = ?').bind(credentialHandle).run();
  }

  private async refreshOAuthCredential(credentialHandle: string, credential: OAuthCredential): Promise<string> {
    if (!this.oauth) {
      throw new Error('Cloudflare authorization expired; reconnect Cloudflare.');
    }
    const response = await (this.oauth.request ?? fetch)('https://dash.cloudflare.com/oauth2/token', {
      method: 'POST',
      headers: {
        authorization: `Basic ${btoa(`${this.oauth.clientId}:${this.oauth.clientSecret}`)}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.oauth.clientId,
        refresh_token: credential.refreshToken,
      }),
    });
    const token = (await response.json().catch(() => null)) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    } | null;
    if (!response.ok || !token?.access_token) {
      throw new Error('Cloudflare authorization expired; reconnect Cloudflare.');
    }
    const refreshed: OAuthCredential = {
      version: 1,
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? credential.refreshToken,
      expiresAt: Date.now() + Math.max(0, token.expires_in ?? 3600) * 1_000,
    };
    const encrypted = await this.encrypt(JSON.stringify(refreshed));
    await this.db
      .prepare(
        `UPDATE cloudflare_credentials
         SET ciphertext_base64 = ?, iv_base64 = ?, rotated_at = ? WHERE handle = ?`,
      )
      .bind(encrypted.ciphertextBase64, encrypted.ivBase64, Date.now(), credentialHandle)
      .run();
    return refreshed.accessToken;
  }

  private async encrypt(value: string): Promise<{ ciphertextBase64: string; ivBase64: string }> {
    const key = await importEncryptionKey(this.encryptionKeyBase64, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value));
    return { ciphertextBase64: bytesToBase64(new Uint8Array(ciphertext)), ivBase64: bytesToBase64(iv) };
  }
}

type OAuthCredential = {
  version: 1;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

function parseOAuthCredential(value: string): OAuthCredential | null {
  try {
    const parsed = JSON.parse(value) as Partial<OAuthCredential>;
    return parsed.version === 1 &&
      typeof parsed.accessToken === 'string' &&
      typeof parsed.refreshToken === 'string' &&
      typeof parsed.expiresAt === 'number'
      ? (parsed as OAuthCredential)
      : null;
  } catch {
    return null;
  }
}

async function importEncryptionKey(value: string, usages: KeyUsage[]): Promise<CryptoKey> {
  const bytes = base64ToBytes(value);
  if (bytes.byteLength !== AES_256_KEY_BYTES) {
    throw new Error('CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY must contain exactly 32 bytes.');
  }
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, usages);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error('Cloudflare credential encryption material is not valid base64.');
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
