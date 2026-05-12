import { createFileRoute } from '@tanstack/react-router'
import {
  buildCodexOAuthConfig,
  readCodexAccountFromRequest,
  refreshCodexTokenFromRequest,
} from '#/lib/codex-oauth'
import { summarizeCodexAuthState } from '#/lib/model-auth'

export async function handleCodexOAuthStatus(request: Request) {
  const token = await refreshCodexTokenFromRequest(
    request,
    buildCodexOAuthConfig(request),
  )
  const headers = new Headers()

  if (token.setCookie) {
    headers.append('set-cookie', token.setCookie)
  }

  return Response.json(
    summarizeCodexAuthState({
      account: readCodexAccountFromRequest(request),
      hasToken: Boolean(token.accessToken),
    }),
    { headers },
  )
}

export const Route = createFileRoute('/api/codex-auth/status')({
  server: {
    handlers: {
      GET: async ({ request }) => handleCodexOAuthStatus(request),
    },
  },
})
