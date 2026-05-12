import { createFileRoute } from '@tanstack/react-router'
import { requireAppSession } from '#/lib/app-auth'
import { createStripeProjectsConnectResponse } from '#/lib/stripe-projects'

export async function handleStripeProjectsConnect(request: Request) {
  const auth = await requireAppSession(request)

  if (auth.response) {
    return auth.response
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
