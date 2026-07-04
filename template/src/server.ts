import handler from "@tanstack/react-start/server-entry";
import { routeAgentRequest } from "agents";
import { z } from "zod";

export { AppAgent } from "./agents/app-agent";

type DecisionRow = {
  id: string;
  title: string;
  detail: string;
  created_at: number;
};

type AppDecision = {
  id: string;
  title: string;
  detail: string;
  createdAt: number;
};

const decisionRequestSchema = z.object({
  id: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1).optional(),
  detail: z.string().trim().min(1, "Provide a non-empty decision detail."),
  createdAt: z.number().finite().optional(),
});

export default {
  async fetch(request: Request, env: Env) {
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) {
      return agentResponse;
    }

    const url = new URL(request.url);

    if (url.pathname === "/api/decisions") {
      return handleDecisionsRequest(request, env);
    }

    return handler.fetch(request);
  },
} satisfies ExportedHandler<Env>;

async function handleDecisionsRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT id, title, detail, created_at FROM decisions ORDER BY created_at DESC",
    ).all<DecisionRow>();

    return Response.json(results.map(rowToDecision));
  }

  if (request.method === "POST") {
    let rawBody: unknown;

    try {
      rawBody = await request.json();
    } catch {
      return Response.json(
        { error: "Expected a JSON request body." },
        { status: 400 },
      );
    }

    const parsedBody = decisionRequestSchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return Response.json(
        {
          error:
            parsedBody.error.issues[0]?.message ?? "Invalid decision request.",
        },
        { status: 400 },
      );
    }

    const body = parsedBody.data;

    const decision: AppDecision = {
      id: body.id ?? crypto.randomUUID(),
      title: body.title?.trim() || "Decision",
      detail: body.detail,
      createdAt: body.createdAt ?? Date.now(),
    };

    await env.DB.prepare(
      "INSERT INTO decisions (id, title, detail, created_at) VALUES (?, ?, ?, ?)",
    )
      .bind(decision.id, decision.title, decision.detail, decision.createdAt)
      .run();

    return Response.json(decision, { status: 201 });
  }

  return new Response("Method not allowed", {
    status: 405,
    headers: { Allow: "GET, POST" },
  });
}

function rowToDecision(row: DecisionRow): AppDecision {
  return {
    id: row.id,
    title: row.title,
    detail: row.detail,
    createdAt: row.created_at,
  };
}
