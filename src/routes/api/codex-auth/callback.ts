import { createFileRoute } from '@tanstack/react-router'
import { buildCodexOAuthConfig, exchangeOAuthCallback } from '#/lib/codex-oauth'

export function handleCodexOAuthCallback(request: Request) {
  return exchangeOAuthCallback(request, buildCodexOAuthConfig(request))
}

export const Route = createFileRoute('/api/codex-auth/callback')({
  server: {
    handlers: {
      GET: async ({ request }) => handleCodexOAuthCallback(request),
    },
  },
})
