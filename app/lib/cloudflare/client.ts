import type { DataOperationArgs, DataOperationPath, DataOperationResult } from './data-api';
import {
  fetchWithRuntimeSession,
  getUserRuntimeSession,
  UserRuntimeSessionError,
  userWorkspacePreparingStore,
} from './runtime-session';

/**
 * A warm runtime answers a data operation in far less than this, so the bound stays short.
 * It covers the request only: a workspace that is still being prepared is a separate,
 * minutes-long wait owned by the runtime session, and racing that wait with this clock
 * reported a workspace that was merely not ready yet as a failed operation.
 */
const DATA_OPERATION_TIMEOUT_MS = 15_000;

export class UserRuntimeRequestError extends Error {
  readonly retryable: boolean;

  constructor(
    message: string,
    readonly status: number | undefined,
    retryable?: unknown,
  ) {
    super(message);
    this.name = 'UserRuntimeRequestError';
    this.retryable =
      typeof retryable === 'boolean'
        ? retryable
        : status === undefined || status === 408 || status === 429 || status >= 500;
  }
}

export class DataOperationError extends UserRuntimeRequestError {
  constructor(message: string, status: number | undefined, retryable?: unknown) {
    super(message, status, retryable);
    this.name = 'DataOperationError';
  }
}

/**
 * Not a fault: the workspace is being built, so the operation could not be answered yet.
 * It resolves on its own once provisioning finishes, which is why it stays retryable and
 * why the surfaces that render it say "not ready yet" rather than "something went wrong".
 */
export class WorkspacePreparingError extends DataOperationError {
  constructor(path: DataOperationPath) {
    super(`Ghostbuild is still preparing your workspace, so ${path} could not run yet.`, undefined, true);
    this.name = 'WorkspacePreparingError';
  }
}

/** Whether an error means the workspace is not ready yet, rather than unreachable or broken. */
export function isWorkspacePreparingError(error: unknown): boolean {
  return (
    error instanceof WorkspacePreparingError ||
    (error instanceof UserRuntimeSessionError && error.code === 'workspace_preparing')
  );
}

export async function executeDataOperation<Path extends DataOperationPath>(
  path: Path,
  args: DataOperationArgs<Path>,
  options: { signal?: AbortSignal } = {},
): Promise<DataOperationResult<Path>> {
  options.signal?.throwIfAborted();
  // Acquired before the operation clock starts: the session request is what waits out
  // provisioning, and it carries its own readiness deadline.
  const session = await getUserRuntimeSession(options.signal);
  options.signal?.throwIfAborted();
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  if (options.signal?.aborted) {
    abortFromCaller();
  }
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, DATA_OPERATION_TIMEOUT_MS);

  try {
    const response = await fetchWithRuntimeSession(session, '/v1/data', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path, args }),
      signal: controller.signal,
    });
    if (timedOut) {
      throw dataOperationTimeoutError(path);
    }
    options.signal?.throwIfAborted();

    const body = (await response.json().catch(() => null)) as {
      result?: DataOperationResult<Path>;
      error?: string;
      retryable?: unknown;
    } | null;
    if (timedOut) {
      throw dataOperationTimeoutError(path);
    }
    options.signal?.throwIfAborted();
    if (!response.ok) {
      throw new DataOperationError(body?.error ?? `Data operation failed: ${path}`, response.status, body?.retryable);
    }
    if (!body || !Object.hasOwn(body, 'result')) {
      throw new DataOperationError(`Data operation returned a malformed response: ${path}`, response.status, false);
    }
    return body.result as DataOperationResult<Path>;
  } catch (error) {
    if (timedOut) {
      throw dataOperationTimeoutError(path);
    }
    options.signal?.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timeoutId);
    options.signal?.removeEventListener('abort', abortFromCaller);
  }
}

function dataOperationTimeoutError(path: DataOperationPath): Error {
  // A workspace this browser already holds a session for can start preparing again — a stale
  // runtime is redeployed underneath it — so ask which state the runtime is in rather than
  // calling every unanswered request unreachable.
  if (userWorkspacePreparingStore.get()) {
    return new WorkspacePreparingError(path);
  }
  return new DataOperationError(`Ghostbuild timed out while running ${path}. Please try again.`, undefined, true);
}
