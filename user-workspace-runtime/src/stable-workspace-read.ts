class StableWorkspaceReadConflictError extends Error {
  readonly code = 'workspace_read_conflict';

  constructor() {
    super('The project changed while it was being read. Retry the read.');
    this.name = 'StableWorkspaceReadConflictError';
  }
}

/** Labels an async read only with a revision observed unchanged on both sides of that read. */
export async function stableWorkspaceRead<T>(
  revision: () => number,
  read: () => Promise<T>,
  maxAttempts = 3,
): Promise<{ value: T; revision: number }> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const before = revision();
    const value = await read();
    const after = revision();
    if (before === after) {
      return { value, revision: after };
    }
  }
  throw new StableWorkspaceReadConflictError();
}
