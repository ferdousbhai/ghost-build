import { createFileRoute } from '@tanstack/react-router'
import type { BuildCheckResult } from '#/lib/build-checks'
import { createBuildPreviewResult } from '#/lib/build-preview'
import { readCodexTokenFromRequest } from '#/lib/codex-oauth'
import type { GeneratedWorkerApp } from '#/lib/generated-worker-app'

export const Route = createFileRoute('/api/build/preview')({
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
        }

        if (!payload.generatedApp || !payload.checkResult) {
          return Response.json(
            { error: 'Generated Worker app and checks are required.' },
            { status: 400 },
          )
        }

        try {
          return Response.json({
            preview: createBuildPreviewResult({
              checkResult: payload.checkResult,
              generatedApp: payload.generatedApp,
              origin: new URL(request.url).origin,
            }),
          })
        } catch (error) {
          return Response.json(
            {
              error:
                error instanceof Error
                  ? error.message
                  : 'Unable to prepare preview.',
            },
            { status: 400 },
          )
        }
      },
    },
  },
})
