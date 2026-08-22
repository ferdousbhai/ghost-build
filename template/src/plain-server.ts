import handler from "@tanstack/react-start/server-entry";
import { finalizeApplicationResponse } from "./application-response";

export default {
  fetch(request: Request) {
    return finalizeApplicationResponse(request, null, () =>
      handler.fetch(request),
    );
  },
} satisfies ExportedHandler<Env>;
