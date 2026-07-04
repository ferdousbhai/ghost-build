import type { DataOperationArgs, DataOperationPath, DataOperationResult } from './data-api';

export async function executeDataOperation<Path extends DataOperationPath>(
  path: Path,
  args: DataOperationArgs<Path>,
): Promise<DataOperationResult<Path>> {
  const response = await fetch('/api/data', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ path, args }),
  });

  const body = (await response.json().catch(() => null)) as {
    result?: DataOperationResult<Path>;
    error?: string;
  } | null;
  if (!response.ok) {
    throw new Error(body?.error ?? `Data operation failed: ${path}`);
  }
  return body?.result as DataOperationResult<Path>;
}
