export class UnauthorizedError extends Error {
  constructor() {
    super('Unauthorized');
  }
}

export function getSessionId(args: unknown): string | null {
  if (args && typeof args === 'object' && 'sessionId' in args && typeof args.sessionId === 'string') {
    return args.sessionId;
  }
  return null;
}
