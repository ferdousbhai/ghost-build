import { getAuthSession } from './auth';

type AgentRequestIdentity = {
  ownerId: string;
  userId: string;
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
            MAX(CASE WHEN chats.is_deleted <> 0 OR chats.creator_id <> ? THEN 1 ELSE 0 END) AS has_conflict
     FROM chats
     LEFT JOIN chat_transcripts ON chat_transcripts.chat_id = chats.id
     WHERE chats.initial_id = ? OR chat_transcripts.agent_name = ?`,
  )
    .bind(identity.ownerId, agentName, agentName)
    .first<{ match_count: number; has_conflict: number | null }>();
  if (chat && chat.match_count > 0 && chat.has_conflict !== 0) {
    return { response: Response.json({ error: 'Agent not found.' }, { status: 404 }) };
  }
  return { identity };
}

export async function resolveAgentRequestIdentity(request: Request, env: Env): Promise<AgentRequestIdentity | null> {
  const session = await getAuthSession(env, request);
  if (!session) {
    return null;
  }
  return {
    ownerId: session.user.id,
    userId: session.user.id,
  };
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
