import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'
import { getAgentByName } from 'agents'
import { readCodexTokenFromRequest } from '#/lib/codex-oauth'
import { GhostBuildAgent, type GhostBuildEnv } from '#/lib/ghost-agent'

export async function handleCloudflareMcpConnect(request: Request) {
  if (!(await readCodexTokenFromRequest(request))) {
    return Response.json({ error: 'Codex sign-in is required.' }, { status: 401 })
  }

  const payload = (await request.json().catch(() => ({}))) as {
    sessionId?: string
  }

  if (!payload.sessionId) {
    return Response.json(
      { error: 'Builder session id is required for Cloudflare MCP authorization.' },
      { status: 400 },
    )
  }

  const agent = await getAgentByName<GhostBuildEnv, GhostBuildAgent>(
    (env as GhostBuildEnv).GhostBuildAgent,
    payload.sessionId,
  )

  return Response.json({
    connection: await agent.connectCloudflareApiMcp(new URL(request.url).origin),
  })
}

export const Route = createFileRoute('/api/cloudflare-mcp/connect')({
  server: {
    handlers: {
      POST: async ({ request }) => handleCloudflareMcpConnect(request),
    },
  },
})
