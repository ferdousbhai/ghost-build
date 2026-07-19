import type { DataOperationArgs, DataOperationPath, DataOperationResult } from './data-api';

const DATA_OPERATION_TIMEOUT_MS = 15_000;

export async function executeDataOperation<Path extends DataOperationPath>(
  path: Path,
  args: DataOperationArgs<Path>,
  options: { signal?: AbortSignal } = {},
): Promise<DataOperationResult<Path>> {
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
    const response = await fetch('/api/data', {
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
    } | null;
    if (timedOut) {
      throw dataOperationTimeoutError(path);
    }
    options.signal?.throwIfAborted();
    if (!response.ok) {
      throw new Error(body?.error ?? `Data operation failed: ${path}`);
    }
    if (!body || !Object.hasOwn(body, 'result')) {
      throw new Error(`Data operation returned a malformed response: ${path}`);
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
  return new Error(`Ghostbuild timed out while running ${path}. Please try again.`);
}
