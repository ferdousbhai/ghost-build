import { createFileRoute } from '@tanstack/react-router'
import { createAppAuthStatus } from '#/lib/app-auth'

export async function handleAppAuthStatus(request: Request) {
  return Response.json(await createAppAuthStatus(request))
}

export const Route = createFileRoute('/api/app-auth/status')({
  server: {
    handlers: {
      GET: async ({ request }) => handleAppAuthStatus(request),
    },
  },
})
