import { createFileRoute } from '@tanstack/react-router'
import { readCodexTokenFromRequest } from '#/lib/codex-oauth'
import { createStripeProjectsStatus } from '#/lib/stripe-projects'

export async function handleStripeProjectsStatus(request: Request) {
  if (!(await readCodexTokenFromRequest(request))) {
    return Response.json({ error: 'Codex sign-in is required.' }, { status: 401 })
  }

  return Response.json(await createStripeProjectsStatus(request))
}

export const Route = createFileRoute('/api/stripe-projects/status')({
  server: {
    handlers: {
      GET: async ({ request }) => handleStripeProjectsStatus(request),
    },
  },
})
