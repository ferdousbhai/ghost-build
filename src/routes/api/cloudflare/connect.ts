import { createFileRoute } from '@tanstack/react-router'
import { connectCloudflareToken } from '#/lib/cloudflare-auth'

export function handleCloudflareConnect(
  request: Request,
  fetcher: typeof fetch = fetch,
) {
  return connectCloudflareToken(request, undefined, fetcher)
}

export const Route = createFileRoute('/api/cloudflare/connect')({
  server: {
    handlers: {
      POST: async ({ request }) => handleCloudflareConnect(request),
    },
  },
})
