import { createFileRoute } from '@tanstack/react-router'
import { disconnectStripeProjects } from '#/lib/stripe-projects'

export const Route = createFileRoute('/api/stripe-projects/disconnect')({
  server: {
    handlers: {
      POST: async () => disconnectStripeProjects(),
    },
  },
})
