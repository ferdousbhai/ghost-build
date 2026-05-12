import { createFileRoute } from '@tanstack/react-router'
import { runGeneratedWorkerChecks } from '#/lib/build-checks'
import { readCodexTokenFromRequest } from '#/lib/codex-oauth'
import type { GeneratedWorkerApp } from '#/lib/generated-worker-app'

export const Route = createFileRoute('/api/build/checks')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await readCodexTokenFromRequest(request))) {
          return Response.json({ error: 'Codex sign-in is required.' }, {
            status: 401,
          })
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
