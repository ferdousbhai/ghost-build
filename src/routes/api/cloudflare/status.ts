import { createFileRoute } from '@tanstack/react-router'
import { verifyCloudflareConnectionFromRequest } from '#/lib/cloudflare-auth'

export async function handleCloudflareStatus(
  request: Request,
  fetcher: typeof fetch = fetch,
) {
  return Response.json(
    await verifyCloudflareConnectionFromRequest(request, fetcher),
  )
}

export const Route = createFileRoute('/api/cloudflare/status')({
  server: {
    handlers: {
      GET: async ({ request }) => handleCloudflareStatus(request),
    },
  },
})
