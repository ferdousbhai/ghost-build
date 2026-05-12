import { createFileRoute } from '@tanstack/react-router'
import type { AgentPlan } from '#/lib/agent'
import { requireAppSession } from '#/lib/app-auth'
import { generateWorkerAppFromPlan } from '#/lib/generated-worker-app'

export const Route = createFileRoute('/api/build/generate')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = await requireAppSession(request)

        if (auth.response) {
          return auth.response
        }

        const payload = (await request.json().catch(() => ({}))) as {
          plan?: AgentPlan
        }

        if (!payload.plan) {
          return Response.json({ error: 'Plan is required.' }, { status: 400 })
        }

        return Response.json({
          generatedApp: generateWorkerAppFromPlan(payload.plan),
        })
      },
    },
  },
})
