import { createFileRoute } from '@tanstack/react-router'
import { auth } from '#/lib/app-auth'

export async function handleAppAuthLogout(request: Request) {
  await auth.api.signOut({ headers: request.headers })

  return Response.json({ ok: true })
}

export const Route = createFileRoute('/api/app-auth/logout')({
  server: {
    handlers: {
      POST: async ({ request }) => handleAppAuthLogout(request),
    },
  },
})
