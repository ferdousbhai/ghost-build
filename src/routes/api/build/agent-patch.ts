import { createFileRoute } from '@tanstack/react-router'
import type { BuildCheckResult } from '#/lib/build-checks'
import { requireAppSession } from '#/lib/app-auth'
import { proposeAndApplyGeneratedWorkerPatches } from '#/lib/generated-worker-agent-patch'
import type { GeneratedWorkerApp } from '#/lib/generated-worker-app'
import { readServerOpenAiApiKey } from '#/lib/server-model-auth'

export const Route = createFileRoute('/api/build/agent-patch')({
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
              generatedApp: payload.generatedApp,
              goal: payload.goal,
              openAiApiKey: readServerOpenAiApiKey(),
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
