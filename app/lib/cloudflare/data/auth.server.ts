import { getAuth } from '~/lib/.server/auth';
import { getGuestSessionIdFromCookie, isGuestSessionId } from '~/lib/guest-session';

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
    return;
  }
  if (isGuestSessionId(sessionId)) {
    requireMatchingGuestSession(request, sessionId);
    return;
  }

  const session = await getAuth(env, request).api.getSession({ headers: request.headers });
  if (!session || session.user.id !== sessionId) {
    throw new UnauthorizedError();
  }
}

export async function claimGuestSession(
  env: Env,
  args: { guestSessionId: string; sessionId: string },
  request: Request,
): Promise<null> {
  if (!isGuestSessionId(args.guestSessionId)) {
    throw new UnauthorizedError();
  }
  requireMatchingGuestSession(request, args.guestSessionId);
  if (args.guestSessionId === args.sessionId) {
    return null;
  }

  await env.DB.prepare('UPDATE chats SET creator_id = ? WHERE creator_id = ?')
    .bind(args.sessionId, args.guestSessionId)
    .run();
  return null;
}

function requireMatchingGuestSession(request: Request, sessionId: string): void {
  const cookieSessionId = getGuestSessionIdFromCookie(request.headers.get('cookie'));
  if (cookieSessionId !== sessionId) {
    throw new UnauthorizedError();
  }
}
