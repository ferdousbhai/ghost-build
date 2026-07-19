import handler from "@tanstack/react-start/server-entry";
import { getAgentByName } from "agents";
import { finalizeApplicationResponse } from "./application-response";
import { routeAppAgentRequest, type AppAgentResolver } from "./agent-routing";
import { cleanupExpiredAgentSecurityState } from "./agent-security";

export { AppAgent } from "./agents/app-agent";

export default {
  async fetch(request: Request, env: Env) {
    const agentResponse = await routeAppAgentRequest(
      request,
      env,
      getAgentByName as unknown as AppAgentResolver,
    );
    return finalizeApplicationResponse(request, agentResponse, () =>
      handler.fetch(request),
    );
  },
  async scheduled(controller: ScheduledController, env: Env) {
    await cleanupExpiredAgentSecurityState(env.DB, controller.scheduledTime);
  },
} satisfies ExportedHandler<Env>;
