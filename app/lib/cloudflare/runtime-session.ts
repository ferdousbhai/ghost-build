import { atom } from 'nanostores';

type UserRuntimeSession = {
  endpoint: string;
  token: string;
  expiresAt: number;
};

const REFRESH_SKEW_MS = 30_000;
const PREPARATION_RETRY_DEADLINE_MS = 15 * 60_000;
const PREPARATION_RETRY_MAX_DELAY_MS = 5_000;
let pending: Promise<UserRuntimeSession> | null = null;
export const userRuntimeEndpointStore = atom<string | null>(null);
let current: UserRuntimeSession | null = null;
let generation = 0;

export async function getUserRuntimeSession(): Promise<UserRuntimeSession> {
  if (current && current.expiresAt - Date.now() > REFRESH_SKEW_MS) {
    return current;
  }
  if (pending) {
    return pending;
  }
  const requestGeneration = generation;
  const request = requestUserRuntimeSession(() => generation === requestGeneration)
    .then((session) => {
      if (generation !== requestGeneration) {
        throw new Error('The runtime session request was canceled.');
      }
      current = session;
      userRuntimeEndpointStore.set(session.endpoint);
      return session;
    })
    .finally(() => {
      if (pending === request) {
        pending = null;
      }
    });
  pending = request;
  return request;
}

async function requestUserRuntimeSession(isCurrent: () => boolean): Promise<UserRuntimeSession> {
  const deadline = Date.now() + PREPARATION_RETRY_DEADLINE_MS;
  let retry = 0;
  for (;;) {
    if (!isCurrent()) {
      throw new Error('The runtime session request was canceled.');
    }
    const response = await fetch('/api/cloudflare/runtime-session', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    const payload = (await response.json().catch(() => null)) as {
      endpoint?: string;
      token?: string;
      expiresAt?: number;
      code?: string;
      error?: string;
    } | null;
    if (response.status === 409 && payload?.code === 'workspace_preparing' && Date.now() < deadline) {
      if (!isCurrent()) {
        throw new Error('The runtime session request was canceled.');
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(1_000 * 2 ** retry++, PREPARATION_RETRY_MAX_DELAY_MS)),
      );
      continue;
    }
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
    return session;
  }
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
  generation += 1;
  current = null;
  pending = null;
  userRuntimeEndpointStore.set(null);
}
