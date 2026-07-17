import type { DataOperationArgs, DataOperationPath, DataOperationResult } from './data-api';

const DATA_OPERATION_TIMEOUT_MS = 15_000;

export async function executeDataOperation<Path extends DataOperationPath>(
  path: Path,
  args: DataOperationArgs<Path>,
): Promise<DataOperationResult<Path>> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DATA_OPERATION_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch('/api/data', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path, args }),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Ghostbuild timed out while running ${path}. Please try again.`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  const body = (await response.json().catch(() => null)) as {
    result?: DataOperationResult<Path>;
    error?: string;
  } | null;
  if (!response.ok) {
    throw new Error(body?.error ?? `Data operation failed: ${path}`);
  }
  return body?.result as DataOperationResult<Path>;
}
