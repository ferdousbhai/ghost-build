import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'
import { getAgentByName } from 'agents'
import { requireAppSession } from '#/lib/app-auth'
import { type CloudflareMcpStatus } from '#/lib/cloudflare-mcp'
import { GhostBuildAgent, type GhostBuildEnv } from '#/lib/ghost-agent'

export async function handleCloudflareMcpStatus(request: Request) {
  const auth = await requireAppSession(request)

  if (auth.response) {
    return auth.response
  }

  const sessionId = new URL(request.url).searchParams.get('sessionId')

  if (!sessionId) {
    return Response.json({
      status: 'not-started',
      message: 'Create a builder session before authorizing Cloudflare API MCP.',
      serverName: 'cloudflare-api',
      serverUrl: 'https://mcp.cloudflare.com/mcp',
      toolsCount: 0,
    } satisfies CloudflareMcpStatus)
  }

  const agent = await getAgentByName<GhostBuildEnv, GhostBuildAgent>(
    (env as GhostBuildEnv).GhostBuildAgent,
    sessionId,
  )

  return Response.json(await agent.getCloudflareApiMcpStatus())
}

export const Route = createFileRoute('/api/cloudflare-mcp/status')({
  server: {
    handlers: {
      GET: async ({ request }) => handleCloudflareMcpStatus(request),
    },
  },
})
