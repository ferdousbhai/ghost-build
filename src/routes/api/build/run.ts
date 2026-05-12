import { createFileRoute } from '@tanstack/react-router'
import type { AgentPlan } from '#/lib/agent'
import { runGeneratedWorkerBuildPipeline } from '#/lib/build-pipeline'
import { readCodexTokenFromRequest } from '#/lib/codex-oauth'

export const Route = createFileRoute('/api/build/run')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await readCodexTokenFromRequest(request))) {
          return Response.json({ error: 'Codex sign-in is required.' }, {
            status: 401,
          })
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
