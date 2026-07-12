import handler from "@tanstack/react-start/server-entry";
import { routeAgentRequest } from "agents";

export { AppAgent } from "./agents/app-agent";

export default {
  async fetch(request: Request, env: Env) {
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) {
      return agentResponse;
    }

    return handler.fetch(request);
  },
} satisfies ExportedHandler<Env>;
