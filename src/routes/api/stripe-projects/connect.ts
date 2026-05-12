import { createFileRoute } from '@tanstack/react-router'
import { readCodexTokenFromRequest } from '#/lib/codex-oauth'
import { createStripeProjectsConnectResponse } from '#/lib/stripe-projects'

export async function handleStripeProjectsConnect(request: Request) {
  if (!(await readCodexTokenFromRequest(request))) {
    return Response.json({ error: 'Codex sign-in is required.' }, { status: 401 })
  }

  return createStripeProjectsConnectResponse(request)
}

export const Route = createFileRoute('/api/stripe-projects/connect')({
  server: {
    handlers: {
      POST: async ({ request }) => handleStripeProjectsConnect(request),
    },
  },
})
