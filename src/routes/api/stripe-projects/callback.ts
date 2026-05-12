import { createFileRoute } from '@tanstack/react-router'
import { createStripeProjectsCallbackResponse } from '#/lib/stripe-projects'

export const Route = createFileRoute('/api/stripe-projects/callback')({
  server: {
    handlers: {
      GET: async ({ request }) => createStripeProjectsCallbackResponse(request),
    },
  },
})
