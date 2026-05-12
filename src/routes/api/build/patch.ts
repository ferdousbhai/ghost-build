import { createFileRoute } from '@tanstack/react-router'
import { readCodexTokenFromRequest } from '#/lib/codex-oauth'
import {
  applyGeneratedWorkerPatches,
  type GeneratedWorkerPatch,
} from '#/lib/generated-worker-patch'
import type { GeneratedWorkerApp } from '#/lib/generated-worker-app'

export const Route = createFileRoute('/api/build/patch')({
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
          patches?: Array<GeneratedWorkerPatch>
        }

        if (!payload.generatedApp || !payload.patches) {
          return Response.json(
            { error: 'Generated Worker app and patches are required.' },
            { status: 400 },
          )
        }

        try {
          return Response.json({
            patchResult: applyGeneratedWorkerPatches(
              payload.generatedApp,
              payload.patches,
            ),
          })
        } catch (error) {
          return Response.json(
            {
              error:
                error instanceof Error
                  ? error.message
                  : 'Unable to apply generated Worker patches.',
            },
            { status: 400 },
          )
        }
      },
    },
  },
})
