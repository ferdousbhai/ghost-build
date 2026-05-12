import { createFileRoute } from '@tanstack/react-router'
import type { AgentPlan } from '#/lib/agent'
import type { BuildCheckResult } from '#/lib/build-checks'
import { repairGeneratedWorkerApp } from '#/lib/build-repair'
import { requireAppSession } from '#/lib/app-auth'
import type { GeneratedWorkerApp } from '#/lib/generated-worker-app'

export const Route = createFileRoute('/api/build/repair')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = await requireAppSession(request)

        if (auth.response) {
          return auth.response
        }

        const payload = (await request.json().catch(() => ({}))) as {
          checkResult?: BuildCheckResult
          generatedApp?: GeneratedWorkerApp
          plan?: AgentPlan
        }

        if (!payload.plan || !payload.generatedApp || !payload.checkResult) {
          return Response.json(
            { error: 'Plan, generated Worker app, and checks are required.' },
            { status: 400 },
          )
        }

        return Response.json({
          repairResult: repairGeneratedWorkerApp({
            checkResult: payload.checkResult,
            generatedApp: payload.generatedApp,
            plan: payload.plan,
          }),
        })
      },
    },
  },
})
