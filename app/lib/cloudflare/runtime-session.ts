import { atom } from 'nanostores';
import { isAiGatewayCreditStatus, type AiGatewayCreditStatus } from './ai-gateway-credit';

type UserRuntimeSession = {
  endpoint: string;
  token: string;
  expiresAt: number;
  aiGatewayCreditStatus?: AiGatewayCreditStatus;
  correlationId?: string;
};

export type UserRuntimeErrorCode =
  'cloudflare_reauthorization_required' | 'workspace_plan_required' | 'workspace_preparation_failed';

export class UserRuntimeSessionError extends Error {
  constructor(
    message: string,
    readonly code: UserRuntimeErrorCode | null,
  ) {
    super(message);
    this.name = 'UserRuntimeSessionError';
  }
}

const REFRESH_SKEW_MS = 30_000;
const PREPARATION_RETRY_DEADLINE_MS = 15 * 60_000;
const PREPARATION_RETRY_MAX_DELAY_MS = 5_000;
let pending: Promise<UserRuntimeSession> | null = null;
export const userRuntimeEndpointStore = atom<string | null>(null);
export const aiGatewayCreditStatusStore = atom<AiGatewayCreditStatus>('unknown');

/**
 * The server-minted identifier for the request that admitted this browser. It lives
 * beside the session that carries it rather than in `telemetry.client`, because
 * telemetry reads this module and the reverse edge would close an import cycle.
 */
export const telemetryCorrelationIdStore = atom<string | null>(null);
let current: UserRuntimeSession | null = null;
let generation = 0;

export async function getUserRuntimeSession(signal?: AbortSignal): Promise<UserRuntimeSession> {
  signal?.throwIfAborted();
  if (current && current.expiresAt - Date.now() > REFRESH_SKEW_MS) {
    return current;
  }
  if (pending) {
    return waitForRuntimeSession(pending, signal);
  }
  const requestGeneration = generation;
  const request = requestUserRuntimeSession(() => generation === requestGeneration)
    .then((session) => {
      if (generation !== requestGeneration) {
        throw new Error('The runtime session request was canceled.');
      }
      current = session;
      aiGatewayCreditStatusStore.set(session.aiGatewayCreditStatus ?? 'unknown');
      userRuntimeEndpointStore.set(session.endpoint);
      telemetryCorrelationIdStore.set(session.correlationId ?? null);
      return session;
    })
    .finally(() => {
      if (pending === request) {
        pending = null;
      }
    });
  pending = request;
  return waitForRuntimeSession(request, signal);
}

function waitForRuntimeSession(
  request: Promise<UserRuntimeSession>,
  signal: AbortSignal | undefined,
): Promise<UserRuntimeSession> {
  if (!signal) {
    return request;
  }
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new DOMException('The runtime session wait was canceled.', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
    request.then(
      (session) => {
        cleanup();
        resolve(session);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
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
      aiGatewayCreditStatus?: unknown;
      correlationId?: unknown;
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
      throw new UserRuntimeSessionError(
        payload?.error ?? 'The user-owned Ghostbuild runtime is unavailable.',
        isUserRuntimeErrorCode(payload?.code) ? payload.code : null,
      );
    }
    const session: UserRuntimeSession = {
      endpoint: new URL(payload.endpoint).origin,
      token: payload.token,
      expiresAt: payload.expiresAt!,
      aiGatewayCreditStatus: isAiGatewayCreditStatus(payload.aiGatewayCreditStatus)
        ? payload.aiGatewayCreditStatus
        : 'unknown',
      correlationId: typeof payload.correlationId === 'string' ? payload.correlationId : undefined,
    };
    return session;
  }
}

function isUserRuntimeErrorCode(value: unknown): value is UserRuntimeErrorCode {
  return (
    value === 'cloudflare_reauthorization_required' ||
    value === 'workspace_plan_required' ||
    value === 'workspace_preparation_failed'
  );
}

export function requireUserRuntimeEndpoint(): string {
  const endpoint = userRuntimeEndpointStore.get();
  if (!endpoint) {
    throw new Error('The user-owned Ghostbuild runtime has not been loaded.');
  }
  return endpoint;
}

export async function fetchUserRuntime(path: string, init: RequestInit = {}): Promise<Response> {
  const signal = init.signal ?? undefined;
  const session = await getUserRuntimeSession(signal);
  signal?.throwIfAborted();
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${session.token}`);
  return fetch(`${session.endpoint}${path.startsWith('/') ? path : `/${path}`}`, { ...init, headers });
}

export function resetUserRuntimeSession(): void {
  generation += 1;
  current = null;
  pending = null;
  userRuntimeEndpointStore.set(null);
  aiGatewayCreditStatusStore.set('unknown');
  telemetryCorrelationIdStore.set(null);
}
