import { createFileRoute } from '@tanstack/react-router'
import { requireAppSession } from '#/lib/app-auth'
import { createStripeProjectsStatus } from '#/lib/stripe-projects'

export async function handleStripeProjectsStatus(request: Request) {
  const auth = await requireAppSession(request)

  if (auth.response) {
    return auth.response
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
