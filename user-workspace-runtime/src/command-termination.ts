type CommandTerminationRuntime = {
  killExec(id: string, options: { backend: string; signal: 'SIGKILL' }): Promise<void>;
  getExec(
    id: string,
    options: { backend: string; encoding: 'utf8'; resume: 'tail' },
  ): Promise<{ result(): Promise<unknown>; [Symbol.dispose](): void }>;
};

type CommandTerminationTransportError = { message?: unknown; retryable?: unknown };

type CommandTerminationDeadlineOptions = {
  attemptTimeoutMs?: number;
  overallTimeoutMs?: number;
};

const DEFAULT_ATTEMPT_TIMEOUT_MS = 5_000;
const DEFAULT_OVERALL_TIMEOUT_MS = 30_000;

class CommandTerminationAttemptTimeoutError extends Error {
  readonly retryable = true;

  constructor(operation: string) {
    super(`${operation} timed out.`);
  }
}

export class WorkspaceCommandTerminationIndeterminateError extends Error {
  readonly code = 'workspace_command_termination_indeterminate';

  constructor(cause: unknown) {
    super('The workspace command termination could not be confirmed.', { cause });
    this.name = 'WorkspaceCommandTerminationIndeterminateError';
  }
}

/** Force-stop a command and do not settle until its terminal result can be observed. */
export async function terminateWorkspaceCommand(
  runtime: CommandTerminationRuntime,
  id: string,
  backend: 'container-shell',
  retryDelay: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 1_000)),
  options: CommandTerminationDeadlineOptions = {},
): Promise<unknown> {
  const attemptTimeoutMs = options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const deadline = Date.now() + (options.overallTimeoutMs ?? DEFAULT_OVERALL_TIMEOUT_MS);
  let lastError: unknown;

  while (Date.now() < deadline) {
    let killError: unknown;
    try {
      await boundedAttempt(
        runtime.killExec(id, { backend, signal: 'SIGKILL' }),
        deadline,
        attemptTimeoutMs,
        'Workspace command kill RPC',
      );
    } catch (error) {
      killError = error;
    }

    let observer: Awaited<ReturnType<CommandTerminationRuntime['getExec']>> | undefined;
    let observationError: unknown;
    try {
      observer = await boundedAttempt(
        runtime.getExec(id, { backend, encoding: 'utf8', resume: 'tail' }),
        deadline,
        attemptTimeoutMs,
        'Workspace command observer RPC',
        disposeCommandObserver,
      );
      return await boundedAttempt(
        observer.result(),
        deadline,
        attemptTimeoutMs,
        'Workspace command terminal observation',
      );
    } catch (error) {
      observationError = error;
      lastError = error;
    } finally {
      disposeCommandObserver(observer);
    }

    if (!isRetryableCommandTransportError(observationError)) {
      throw new WorkspaceCommandTerminationIndeterminateError(observationError ?? killError);
    }

    try {
      await boundedAttempt(retryDelay(), deadline, attemptTimeoutMs, 'Workspace command termination retry delay');
    } catch (error) {
      lastError = error;
    }
  }

  throw new WorkspaceCommandTerminationIndeterminateError(
    lastError ?? new Error('Command termination deadline elapsed.'),
  );
}

async function boundedAttempt<T>(
  promise: Promise<T>,
  deadline: number,
  attemptTimeoutMs: number,
  operation: string,
  onLateResolve?: (value: T) => void,
): Promise<T> {
  const timeoutMs = Math.min(Math.max(0, attemptTimeoutMs), Math.max(0, deadline - Date.now()));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const rejectTimeout = () => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new CommandTerminationAttemptTimeoutError(operation));
    };

    if (timeoutMs <= 0) {
      rejectTimeout();
    } else {
      timeout = setTimeout(rejectTimeout, timeoutMs);
    }

    void promise.then(
      (value) => {
        if (settled) {
          onLateResolve?.(value);
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function disposeCommandObserver(observer: Awaited<ReturnType<CommandTerminationRuntime['getExec']>> | undefined): void {
  try {
    observer?.[Symbol.dispose]();
  } catch {
    // Observer disposal is best-effort and must not mask the termination outcome.
  }
}

function isRetryableCommandTransportError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const candidate = error as CommandTerminationTransportError;
  return (
    candidate.retryable === true ||
    (typeof candidate.message === 'string' &&
      (candidate.message.includes('reset because its code was updated') ||
        candidate.message.includes('Container service disconnected') ||
        candidate.message.includes('disconnected prematurely')))
  );
}
