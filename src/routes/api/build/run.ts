import { createFileRoute } from '@tanstack/react-router'
import type { AgentPlan } from '#/lib/agent'
import { runGeneratedWorkerBuildPipeline } from '#/lib/build-pipeline'
import { requireAppSession } from '#/lib/app-auth'

export const Route = createFileRoute('/api/build/run')({
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
          pipeline: runGeneratedWorkerBuildPipeline({
            origin: new URL(request.url).origin,
            plan: payload.plan,
          }),
        })
      },
    },
  },
})
