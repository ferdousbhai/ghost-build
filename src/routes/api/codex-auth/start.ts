import { createFileRoute } from '@tanstack/react-router'
import { buildCodexOAuthConfig, createOAuthStart } from '#/lib/codex-oauth'

export function handleCodexOAuthStart(request: Request) {
  return createOAuthStart(buildCodexOAuthConfig(request))
}

export const Route = createFileRoute('/api/codex-auth/start')({
  server: {
    handlers: {
      GET: async ({ request }) => handleCodexOAuthStart(request),
    },
  },
})
