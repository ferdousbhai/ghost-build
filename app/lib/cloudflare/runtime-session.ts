import { atom } from 'nanostores';

type UserRuntimeSession = {
  endpoint: string;
  token: string;
  expiresAt: number;
};

const REFRESH_SKEW_MS = 30_000;
let pending: Promise<UserRuntimeSession> | null = null;
export const userRuntimeEndpointStore = atom<string | null>(null);
let current: UserRuntimeSession | null = null;

export async function getUserRuntimeSession(): Promise<UserRuntimeSession> {
  if (current && current.expiresAt - Date.now() > REFRESH_SKEW_MS) {
    return current;
  }
  if (pending) {
    return pending;
  }
  const request = fetch('/api/cloudflare/runtime-session', {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  })
    .then(async (response) => {
      const payload = (await response.json().catch(() => null)) as {
        endpoint?: string;
        token?: string;
        expiresAt?: number;
        error?: string;
      } | null;
      if (
        !response.ok ||
        !payload?.endpoint ||
        !payload.token ||
        !Number.isSafeInteger(payload.expiresAt) ||
        new URL(payload.endpoint).protocol !== 'https:'
      ) {
        throw new Error(payload?.error ?? 'The user-owned Ghostbuild runtime is unavailable.');
      }
      const session: UserRuntimeSession = {
        endpoint: new URL(payload.endpoint).origin,
        token: payload.token,
        expiresAt: payload.expiresAt!,
      };
      current = session;
      userRuntimeEndpointStore.set(session.endpoint);
      return session;
    })
    .finally(() => {
      pending = null;
    });
  pending = request;
  return request;
}

export function requireUserRuntimeEndpoint(): string {
  const endpoint = userRuntimeEndpointStore.get();
  if (!endpoint) {
    throw new Error('The user-owned Ghostbuild runtime has not been loaded.');
  }
  return endpoint;
}

export async function fetchUserRuntime(path: string, init: RequestInit = {}): Promise<Response> {
  const session = await getUserRuntimeSession();
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${session.token}`);
  return fetch(`${session.endpoint}${path.startsWith('/') ? path : `/${path}`}`, { ...init, headers });
}

export function resetUserRuntimeSession(): void {
  current = null;
  pending = null;
  userRuntimeEndpointStore.set(null);
}
