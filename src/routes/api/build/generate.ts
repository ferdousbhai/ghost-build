import { createFileRoute } from '@tanstack/react-router'
import type { AgentPlan } from '#/lib/agent'
import { readCodexTokenFromRequest } from '#/lib/codex-oauth'
import { generateWorkerAppFromPlan } from '#/lib/generated-worker-app'

export const Route = createFileRoute('/api/build/generate')({
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
          generatedApp: generateWorkerAppFromPlan(payload.plan),
        })
      },
    },
  },
})
