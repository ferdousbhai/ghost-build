import { readJsonBodyWithLimit } from '~/lib/bounded-body';
import { parseUserWorkspaceRuntimeHealth } from './user-workspace-runtime-health';

const READINESS_DEADLINE_MS = 90_000;
const READINESS_REQUEST_TIMEOUT_MS = 10_000;
const READINESS_MAX_ATTEMPTS = 30;
const READINESS_INITIAL_BACKOFF_MS = 500;
const READINESS_MAX_BACKOFF_MS = 5_000;
const MAX_HEALTH_RESPONSE_BYTES = 4 * 1024;

type ReadinessDependencies = {
  request?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  deadlineMs?: number;
  requestTimeoutMs?: number;
};

export async function waitForUserWorkspaceRuntimeReadiness(
  args: {
    endpoint: string;
    controlPlaneSecret: string;
    runtimeVersion: string;
  } & ReadinessDependencies,
): Promise<void> {
  const healthUrl = runtimeHealthUrl(args.endpoint);
  if (args.controlPlaneSecret.length < 32 || !/^[a-f0-9]{64}$/.test(args.runtimeVersion)) {
    throw new UserWorkspaceRuntimeReadinessError('The workspace runtime health-check identity is invalid.');
  }
  const request = args.request ?? fetch;
  const now = args.now ?? Date.now;
  const sleep = args.sleep ?? ((milliseconds: number) => scheduler.wait(milliseconds));
  const random = args.random ?? Math.random;
  const deadlineMs = requirePositiveDuration(args.deadlineMs ?? READINESS_DEADLINE_MS, 'readiness deadline');
  const requestTimeoutMs = requirePositiveDuration(
    args.requestTimeoutMs ?? READINESS_REQUEST_TIMEOUT_MS,
    'readiness request timeout',
  );
  const deadline = now() + deadlineMs;

  for (let attempt = 1; attempt <= READINESS_MAX_ATTEMPTS; attempt += 1) {
    const remainingBeforeRequest = deadline - now();
    if (remainingBeforeRequest <= 0) {
      break;
    }
    let retryAfterMs = 0;
    try {
      const response = await request(healthUrl, {
        headers: { authorization: `Bearer ${args.controlPlaneSecret}` },
        signal: AbortSignal.timeout(Math.max(1, Math.min(requestTimeoutMs, remainingBeforeRequest))),
      });
      if (!response.ok) {
        retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'), now());
        await response.body?.cancel().catch(() => undefined);
        if (!isTransientReadinessStatus(response.status)) {
          throw new UserWorkspaceRuntimeReadinessError(
            `The user-owned workspace runtime rejected its health check (HTTP ${response.status}).`,
          );
        }
      } else {
        const payload = await readJsonBodyWithLimit(response, MAX_HEALTH_RESPONSE_BYTES, 'Workspace runtime health');
        const health = parseUserWorkspaceRuntimeHealth(payload);
        if (health.runtimeVersion === args.runtimeVersion) {
          return;
        }
        // A well-formed response from the previous source digest can be served
        // briefly while the new 100%-traffic deployment propagates.
      }
    } catch (error) {
      if (error instanceof UserWorkspaceRuntimeReadinessError) {
        throw error;
      }
      if (!isTransientFetchFailure(error)) {
        throw new UserWorkspaceRuntimeReadinessError(
          'The user-owned workspace runtime returned an invalid health response.',
          { cause: error },
        );
      }
    }

    if (attempt === READINESS_MAX_ATTEMPTS) {
      break;
    }
    const remainingBeforeBackoff = deadline - now();
    if (remainingBeforeBackoff <= 0) {
      break;
    }
    const backoffMs = exponentialBackoffWithJitter(attempt, random);
    await sleep(Math.min(remainingBeforeBackoff, Math.max(backoffMs, retryAfterMs)));
  }

  throw new UserWorkspaceRuntimeReadinessError(
    'The user-owned workspace runtime was not ready before the health-check deadline.',
  );
}

export class UserWorkspaceRuntimeReadinessError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UserWorkspaceRuntimeReadinessError';
  }
}

function runtimeHealthUrl(endpoint: string): string {
  let url: URL;
  try {
    url = new URL('/v1/health', endpoint.endsWith('/') ? endpoint : `${endpoint}/`);
  } catch {
    throw new UserWorkspaceRuntimeReadinessError('The workspace runtime endpoint is invalid.');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new UserWorkspaceRuntimeReadinessError('The workspace runtime endpoint is invalid.');
  }
  return url.toString();
}

function isTransientReadinessStatus(status: number): boolean {
  return status === 404 || status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

function isTransientFetchFailure(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof DOMException && ['AbortError', 'NetworkError', 'TimeoutError'].includes(error.name))
  );
}

function exponentialBackoffWithJitter(attempt: number, random: () => number): number {
  const ceiling = Math.min(READINESS_INITIAL_BACKOFF_MS * 2 ** (attempt - 1), READINESS_MAX_BACKOFF_MS);
  const sample = Math.min(1, Math.max(0, random()));
  return Math.ceil(ceiling * 0.75 + ceiling * 0.25 * sample);
}

function parseRetryAfterMs(value: string | null, now: number): number {
  if (!value) {
    return 0;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }
  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - now) : 0;
}

function requirePositiveDuration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10 * 60_000) {
    throw new UserWorkspaceRuntimeReadinessError(`The ${label} is invalid.`);
  }
  return value;
}
