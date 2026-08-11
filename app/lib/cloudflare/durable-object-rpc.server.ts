const MAX_RPC_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 100;

type DurableObjectRpcError = {
  message?: unknown;
  overloaded?: unknown;
  retryable?: unknown;
};

/** Retry an idempotent Durable Object RPC with a fresh stub on every attempt. */
export async function retryDurableObjectRpc<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      if (attempt + 1 >= MAX_RPC_ATTEMPTS || !isRetryableDurableObjectError(error)) {
        throw error;
      }
      const backoffMs = BASE_BACKOFF_MS * Math.random() * 2 ** attempt;
      await scheduler.wait(backoffMs);
    }
  }
}

export function isRetryableDurableObjectError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const candidate = error as DurableObjectRpcError;
  if (isDurableObjectOverloadedError(error)) {
    return false;
  }
  return (
    candidate.retryable === true ||
    (typeof candidate.message === 'string' &&
      (candidate.message.includes('reset because its code was updated') ||
        candidate.message.includes('Container service disconnected')))
  );
}

export function isDurableObjectOverloadedError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as DurableObjectRpcError).overloaded === true;
}
