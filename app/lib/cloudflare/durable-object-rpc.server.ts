import { z } from 'zod';

const MAX_RPC_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 100;

/**
 * The runtime surfaces RPC faults as plain objects rather than a shared error class, so each
 * flag falls back on its own: an unexpected `overloaded` must not hide a usable `message`.
 */
const durableObjectRpcErrorSchema = z.looseObject({
  message: z.string().optional().catch(undefined),
  overloaded: z.boolean().optional().catch(undefined),
  retryable: z.boolean().optional().catch(undefined),
});

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
  const parsed = durableObjectRpcErrorSchema.safeParse(error);
  if (!parsed.success || parsed.data.overloaded === true) {
    return false;
  }
  const { message, retryable } = parsed.data;
  return (
    retryable === true ||
    (message !== undefined &&
      (message.includes('reset because its code was updated') || message.includes('Container service disconnected')))
  );
}

export function isDurableObjectOverloadedError(error: unknown): boolean {
  const parsed = durableObjectRpcErrorSchema.safeParse(error);
  return parsed.success && parsed.data.overloaded === true;
}
