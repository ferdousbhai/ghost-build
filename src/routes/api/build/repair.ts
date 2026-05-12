import { createFileRoute } from '@tanstack/react-router'
import type { AgentPlan } from '#/lib/agent'
import type { BuildCheckResult } from '#/lib/build-checks'
import { repairGeneratedWorkerApp } from '#/lib/build-repair'
import { readCodexTokenFromRequest } from '#/lib/codex-oauth'
import type { GeneratedWorkerApp } from '#/lib/generated-worker-app'

export const Route = createFileRoute('/api/build/repair')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await readCodexTokenFromRequest(request))) {
          return Response.json({ error: 'Codex sign-in is required.' }, {
            status: 401,
          })
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
