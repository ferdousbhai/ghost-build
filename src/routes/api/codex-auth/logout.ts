import { createFileRoute } from '@tanstack/react-router'
import { buildCodexOAuthConfig, createCodexLogout } from '#/lib/codex-oauth'

export function handleCodexOAuthLogout(request: Request) {
  return createCodexLogout(request, buildCodexOAuthConfig(request))
}

export const Route = createFileRoute('/api/codex-auth/logout')({
  server: {
    handlers: {
      POST: async ({ request }) => handleCodexOAuthLogout(request),
    },
  },
})
