import { createFileRoute } from '@tanstack/react-router'
import { buildAgentPlan, type AgentPlanRequest } from '#/lib/agent'

export const Route = createFileRoute('/api/plan')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const payload = (await request.json().catch(() => ({}))) as Partial<
          AgentPlanRequest
        >
        const plan = buildAgentPlan(payload)

        return Response.json(plan)
      },
    },
  },
})
