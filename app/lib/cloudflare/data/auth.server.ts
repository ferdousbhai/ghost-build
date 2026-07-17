import { getAuthSession } from '~/lib/.server/auth';

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

export async function requireMatchingSession(env: Env, request: Request, sessionId: string | null): Promise<void> {
  if (!sessionId) {
    throw new UnauthorizedError();
  }
  const session = await getAuthSession(env, request);
  if (!session || session.user.id !== sessionId) {
    throw new UnauthorizedError();
  }
}
