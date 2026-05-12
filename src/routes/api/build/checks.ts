import { createFileRoute } from '@tanstack/react-router'
import { runGeneratedWorkerChecks } from '#/lib/build-checks'
import { requireAppSession } from '#/lib/app-auth'
import type { GeneratedWorkerApp } from '#/lib/generated-worker-app'

export const Route = createFileRoute('/api/build/checks')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = await requireAppSession(request)

        if (auth.response) {
          return auth.response
        }

        const payload = (await request.json().catch(() => ({}))) as {
          generatedApp?: GeneratedWorkerApp
        }

        if (!payload.generatedApp) {
          return Response.json(
            { error: 'Generated Worker app is required.' },
            { status: 400 },
          )
        }

        return Response.json({
          checkResult: runGeneratedWorkerChecks(payload.generatedApp),
        })
      },
    },
  },
})
