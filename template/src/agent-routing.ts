import {
  handleAgentSessionBootstrap,
  resolveAgentSession,
} from "./agent-security";

export type AppAgentRoutingEnv = {
  DB: D1Database;
  AppAgent: unknown;
};

export type AppAgentResolver = (
  namespace: unknown,
  name: string,
) => Promise<{
  refreshAnonymousSessionExpiry(expiresAt: number): Promise<boolean>;
  fetch(request: Request): Promise<Response>;
}>;

export async function routeAppAgentRequest(
  request: Request,
  env: AppAgentRoutingEnv,
  resolveAppAgent: AppAgentResolver,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/agent/session") {
    return handleAgentSessionBootstrap(request, env.DB);
  }
  if (url.pathname === "/agent") {
    const origin = request.headers.get("Origin");
    if (origin !== url.origin) {
      return new Response("Forbidden", {
        status: 403,
        headers: { "Cache-Control": "no-store" },
      });
    }
    const session = await resolveAgentSession(request, env.DB);
    if (!session) {
      return Response.json(
        { error: "An agent session is required." },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    }
    const agent = await resolveAppAgent(env.AppAgent, session.agentName);
    if (!(await agent.refreshAnonymousSessionExpiry(session.expiresAt))) {
      return Response.json(
        { error: "The agent session expired." },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    }
    return agent.fetch(request);
  }
  if (url.pathname.startsWith("/agents/")) {
    return new Response("Not found", { status: 404 });
  }
  return null;
}
