const SESSION_COOKIE = 'ghostbuild_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export type CloudflareAuthUser = {
  id: string;
  name: string;
  email: string;
  image: string | null;
};

export type CloudflareAuthSession = {
  session: {
    id: string;
    userId: string;
    expiresAt: number;
  };
  user: CloudflareAuthUser;
};

type CloudflareOAuthIdentity = {
  subject: string;
  email: string | null;
  name: string | null;
  picture: string | null;
};

type SessionRow = {
  session_id: string;
  user_id: string;
  expires_at: number;
  name: string;
  email: string;
  image: string | null;
};

export async function getAuthSession(env: Env, request: Request): Promise<CloudflareAuthSession | null> {
  const token = cookieValue(request.headers.get('cookie'), SESSION_COOKIE);
  if (!token) {
    return null;
  }
  const tokenHash = await sha256(token);
  const now = Date.now();
  const row = await env.DB.prepare(
    `SELECT auth.id AS session_id, auth.user_id, auth.expires_at,
            users.name, users.email, users.image
     FROM cloudflare_auth_sessions AS auth
     JOIN "user" AS users ON users.id = auth.user_id
     JOIN cloudflare_connections AS connections
       ON connections.user_id = auth.user_id AND connections.status = 'active'
     WHERE auth.token_hash = ? AND auth.expires_at > ?`,
  )
    .bind(tokenHash, now)
    .first<SessionRow>();
  if (!row) {
    return null;
  }
  return {
    session: { id: row.session_id, userId: row.user_id, expiresAt: row.expires_at },
    user: { id: row.user_id, name: row.name, email: row.email, image: row.image },
  };
}

export async function createAuthSession(
  env: Env,
  userId: string,
  request?: Request,
  now = Date.now(),
): Promise<string> {
  const token = randomToken();
  const expiresAt = now + SESSION_MAX_AGE_SECONDS * 1_000;
  await env.DB.prepare(
    `INSERT INTO cloudflare_auth_sessions (id, user_id, token_hash, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), userId, await sha256(token), expiresAt, now, now)
    .run();
  return serializeSessionCookie(token, SESSION_MAX_AGE_SECONDS, isHttps(request));
}

export async function deleteAuthSession(env: Env, request: Request): Promise<void> {
  const token = cookieValue(request.headers.get('cookie'), SESSION_COOKIE);
  if (!token) {
    return;
  }
  await env.DB.prepare('DELETE FROM cloudflare_auth_sessions WHERE token_hash = ?')
    .bind(await sha256(token))
    .run();
}

export function clearAuthSessionCookie(request?: Request): string {
  return serializeSessionCookie('', 0, isHttps(request));
}

export async function upsertCloudflareUser(
  db: D1Database,
  identity: CloudflareOAuthIdentity,
  accountName: string | null,
  now = Date.now(),
): Promise<CloudflareAuthUser> {
  const existingBySubject = await db
    .prepare('SELECT id, name, email, image FROM "user" WHERE cloudflare_subject = ?')
    .bind(identity.subject)
    .first<CloudflareAuthUser>();
  const email = identity.email ?? `${identity.subject}@users.cloudflare.invalid`;
  const name = identity.name ?? accountName ?? 'Cloudflare user';
  const image = identity.picture;
  if (existingBySubject) {
    await updateUser(db, existingBySubject.id, identity.subject, name, email, image, now);
    return { id: existingBySubject.id, name, email, image };
  }

  const existingByEmail = identity.email
    ? await db
        .prepare('SELECT id, name, email, image FROM "user" WHERE email = ?')
        .bind(identity.email)
        .first<CloudflareAuthUser>()
    : null;
  if (existingByEmail) {
    await updateUser(db, existingByEmail.id, identity.subject, name, email, image, now);
    return { id: existingByEmail.id, name, email, image };
  }

  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO "user"
        (id, name, email, emailVerified, image, createdAt, updatedAt, cloudflare_subject)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, name, email, identity.email ? 1 : 0, image, now, now, identity.subject)
    .run();
  return { id, name, email, image };
}

async function updateUser(
  db: D1Database,
  id: string,
  subject: string,
  name: string,
  email: string,
  image: string | null,
  now: number,
) {
  await db
    .prepare(
      `UPDATE "user"
       SET cloudflare_subject = ?, name = ?, email = ?, emailVerified = ?, image = ?, updatedAt = ?
       WHERE id = ?`,
    )
    .bind(subject, name, email, email.endsWith('@users.cloudflare.invalid') ? 0 : 1, image, now, id)
    .run();
}

function serializeSessionCookie(token: string, maxAge: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly${secure ? '; Secure' : ''}; SameSite=Lax; Max-Age=${maxAge}`;
}

function isHttps(request?: Request): boolean {
  return !request || new URL(request.url).protocol === 'https:';
}

function cookieValue(header: string | null, name: string): string | null {
  if (!header) {
    return null;
  }
  for (const part of header.split(';')) {
    const [candidate, ...value] = part.trim().split('=');
    if (candidate === name) {
      try {
        return decodeURIComponent(value.join('='));
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
