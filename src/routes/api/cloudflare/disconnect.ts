import { createFileRoute } from '@tanstack/react-router'
import { disconnectCloudflareToken } from '#/lib/cloudflare-auth'

export function handleCloudflareDisconnect() {
  return disconnectCloudflareToken()
}

export const Route = createFileRoute('/api/cloudflare/disconnect')({
  server: {
    handlers: {
      POST: async () => handleCloudflareDisconnect(),
    },
  },
})
