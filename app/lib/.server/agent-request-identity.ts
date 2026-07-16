import { getGuestSessionIdFromCookie } from '~/lib/guest-session';
import { getAuth } from './auth';
import { getOptionalBinding } from './env';

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
    `SELECT COUNT(*) AS match_count,
            MAX(CASE WHEN is_deleted <> 0 OR creator_id <> ? THEN 1 ELSE 0 END) AS has_conflict
     FROM chats
     WHERE initial_id = ?`,
  )
    .bind(identity.ownerId, agentName)
    .first<{ match_count: number; has_conflict: number | null }>();
  if (chat && chat.match_count > 0 && chat.has_conflict !== 0) {
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
  return guestId ? { billingSubjectKey: await guestBillingSubjectKey(request, env), ownerId: guestId } : null;
}

async function guestBillingSubjectKey(request: Request, env: Env): Promise<string> {
  const secret = getOptionalBinding(env, 'BETTER_AUTH_SECRET');
  if (!secret) {
    throw new Error('Cloudflare binding BETTER_AUTH_SECRET is not configured');
  }
  const source = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`ghostbuild-ai:${source}`));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `guest:${hash}`;
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
