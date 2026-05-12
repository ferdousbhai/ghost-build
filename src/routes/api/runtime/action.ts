import { createFileRoute } from '@tanstack/react-router'
import { requireAppSession } from '#/lib/app-auth'
import {
  assertRuntimeActionAllowed,
  type RuntimeActionRequest,
} from '#/lib/runtime-action-executor'

export async function handleRuntimeAction(request: Request) {
  const auth = await requireAppSession(request)

        if (auth.response) {
          return auth.response
        }

  const payload = (await request.json().catch(() => ({}))) as {
    actionRequest?: RuntimeActionRequest
  }

  if (!payload.actionRequest) {
    return Response.json({ error: 'Runtime action request is required.' }, {
      status: 400,
    })
  }

  try {
    return Response.json({
      result: assertRuntimeActionAllowed(payload.actionRequest),
    })
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Runtime action is not allowed.',
      },
      { status: 400 },
    )
  }
}

export const Route = createFileRoute('/api/runtime/action')({
  server: {
    handlers: {
      POST: async ({ request }) => handleRuntimeAction(request),
    },
  },
})
