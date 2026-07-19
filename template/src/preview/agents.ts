export async function routeAgentRequest() {
  return null;
}

export async function getAgentByName() {
  return {
    async refreshAnonymousSessionExpiry() {
      return true;
    },
    async fetch() {
      return Response.json(
        {
          error:
            "Durable Agent requests are unavailable in static preview mode.",
        },
        { status: 503 },
      );
    },
  };
}
