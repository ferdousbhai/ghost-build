import { createFileRoute } from '@tanstack/react-router'
import type { BuildCheckResult } from '#/lib/build-checks'
import { readCodexTokenFromRequest } from '#/lib/codex-oauth'
import { proposeAndApplyGeneratedWorkerPatches } from '#/lib/generated-worker-agent-patch'
import type { GeneratedWorkerApp } from '#/lib/generated-worker-app'

export const Route = createFileRoute('/api/build/agent-patch')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const codexAccessToken = await readCodexTokenFromRequest(request)

        if (!codexAccessToken) {
          return Response.json({ error: 'Codex sign-in is required.' }, {
            status: 401,
          })
        }

        const payload = (await request.json().catch(() => ({}))) as {
          checkResult?: BuildCheckResult
          generatedApp?: GeneratedWorkerApp
          goal?: string
        }

        if (!payload.generatedApp || !payload.checkResult || !payload.goal) {
          return Response.json(
            { error: 'Goal, generated Worker app, and checks are required.' },
            { status: 400 },
          )
        }

        try {
          return Response.json({
            patchResult: await proposeAndApplyGeneratedWorkerPatches({
              checkResult: payload.checkResult,
              codexAccessToken,
              generatedApp: payload.generatedApp,
              goal: payload.goal,
            }),
          })
        } catch (error) {
          return Response.json(
            {
              error:
                error instanceof Error
                  ? error.message
                  : 'Unable to propose generated Worker patches.',
            },
            { status: 400 },
          )
        }
      },
    },
  },
})
