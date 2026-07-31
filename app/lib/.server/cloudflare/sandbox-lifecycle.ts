import type { ExecOptions, ExecResult, ISandbox } from '@cloudflare/sandbox';

const SANDBOX_RPC_GRACE_MS = 15_000;
const SANDBOX_DESTROY_TIMEOUT_MS = 10_000;
const SANDBOX_DESTROY_RETRY_DELAYS_MS = [250, 1_000] as const;

type SandboxExecutor = Pick<ISandbox, 'exec'>;
type SandboxDestroyer = { destroy(): Promise<unknown> };

/**
 * The Sandbox command timeout is enforced inside the container. Bound the RPC
 * itself as well so a reset or a saturated container application cannot leave a
 * Builder tool waiting indefinitely for a response that will never arrive.
 */
export function sandboxExec(
  sandbox: SandboxExecutor,
  command: string,
  options: ExecOptions & { timeout: number },
): Promise<ExecResult> {
  return withSandboxRpcTimeout(sandbox.exec(command, options), options.timeout, 'Sandbox RPC');
}

export function withSandboxRpcTimeout<T>(request: Promise<T>, commandTimeoutMs: number, operation: string): Promise<T> {
  return withTimeout(
    request,
    commandTimeoutMs + SANDBOX_RPC_GRACE_MS,
    `${operation} timed out after the ${commandTimeoutMs} ms command deadline.`,
  );
}

/** Retry cleanup across transient Durable Object resets before leaving capacity occupied. */
export async function destroySandboxWithRetries(sandbox: SandboxDestroyer, operation: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= SANDBOX_DESTROY_RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) {
      await delay(SANDBOX_DESTROY_RETRY_DELAYS_MS[attempt - 1]!);
    }
    try {
      await withTimeout(
        sandbox.destroy(),
        SANDBOX_DESTROY_TIMEOUT_MS,
        `Sandbox destroy timed out after ${SANDBOX_DESTROY_TIMEOUT_MS} ms.`,
      );
      return;
    } catch (error) {
      lastError = error;
    }
  }
  console.error(`Unable to destroy ${operation} after cleanup retries`, lastError);
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
