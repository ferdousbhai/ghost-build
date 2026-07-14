import { getGuestSessionIdFromCookie } from '~/lib/guest-session';
import { getAuth } from './auth';

type AgentRequestIdentity = {
  billingSubjectKey: string;
  ownerId: string;
  userId?: string;
};

export async function authorizeAgentRequest(
  request: Request,
  env: Env,
): Promise<{ identity: AgentRequestIdentity } | { response: Response }> {
  const identity = await resolveAgentRequestIdentity(request, env);
  if (!identity) {
    return { response: Response.json({ error: 'Agent authentication is required.' }, { status: 401 }) };
  }

  const agentName = builderAgentName(new URL(request.url));
  if (!agentName) {
    return { identity };
  }
  const chat = await env.DB.prepare(
    `SELECT creator_id FROM chats
     WHERE (initial_id = ? OR url_id = ?) AND is_deleted = 0
     LIMIT 1`,
  )
    .bind(agentName, agentName)
    .first<{ creator_id: string }>();
  if (chat && chat.creator_id !== identity.ownerId) {
    return { response: Response.json({ error: 'Agent not found.' }, { status: 404 }) };
  }
  return { identity };
}

export async function resolveAgentRequestIdentity(request: Request, env: Env): Promise<AgentRequestIdentity | null> {
  const session = await getAuth(env, request).api.getSession({ headers: request.headers });
  if (session) {
    return {
      billingSubjectKey: `user:${session.user.id}`,
      ownerId: session.user.id,
      userId: session.user.id,
    };
  }

  const guestId = getGuestSessionIdFromCookie(request.headers.get('cookie'));
  return guestId ? { billingSubjectKey: `guest:${guestId}`, ownerId: guestId } : null;
}

function builderAgentName(url: URL): string | null {
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length < 3 || segments[0] !== 'agents' || segments[1] !== 'builder-agent') {
    return null;
  }
  try {
    return decodeURIComponent(segments[2]);
  } catch {
    return null;
  }
}
