import handler from "@tanstack/react-start/server-entry";
import { getAgentByName } from "agents";
import { finalizeApplicationResponse } from "./application-response";
import { routeAppAgentRequest, type AppAgentResolver } from "./agent-routing";
import { cleanupExpiredAgentSecurityState } from "./agent-security";

export { AppAgent } from "./agents/app-agent";

export default {
  async fetch(request: Request, env: Env) {
    const isolatedPreview =
      (env as Env & { GHOSTBUILD_ISOLATED_PREVIEW?: string })
        .GHOSTBUILD_ISOLATED_PREVIEW === "1";
    if (isolatedPreview && isAgentRoute(new URL(request.url).pathname)) {
      return Response.json(
        {
          code: "workers_ai_unavailable_in_isolated_preview",
          error:
            "Agent and chat routes require the production Workers AI binding.",
        },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }
    const agentResponse = await routeAppAgentRequest(
      request,
      env,
      getAgentByName as unknown as AppAgentResolver,
    );
    return finalizeApplicationResponse(
      request,
      agentResponse,
      () => handler.fetch(request),
      { isolatedPreview },
    );
  },
  async scheduled(controller: ScheduledController, env: Env) {
    await cleanupExpiredAgentSecurityState(
      env.AGENT_SECURITY_DB,
      controller.scheduledTime,
    );
  },
} satisfies ExportedHandler<Env>;

function isAgentRoute(pathname: string): boolean {
  return (
    pathname === "/agent" ||
    pathname.startsWith("/agent/") ||
    pathname === "/agents" ||
    pathname.startsWith("/agents/") ||
    pathname === "/api/agent/session"
  );
}
