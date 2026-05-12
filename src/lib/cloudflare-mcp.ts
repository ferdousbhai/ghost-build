export type CloudflareMcpStatus =
  | {
      status: 'not-started'
      message: string
      serverName: string
      serverUrl: string
      toolsCount: 0
    }
  | {
      status: 'authenticating'
      message: string
      serverName: string
      serverUrl: string
      authUrl: string
      toolsCount: number
    }
  | {
      status: 'connecting' | 'ready' | 'failed'
      message: string
      serverName: string
      serverUrl: string
      error?: string
      toolsCount: number
    }

type McpServerState = {
  name?: string
  server_url?: string
  auth_url?: string | null
  state?: string
  error?: string | null
}

type McpServersState = {
  servers?: Record<string, McpServerState>
  tools?: Array<{ serverId?: string }>
}

export const cloudflareApiMcpServer = {
  name: 'cloudflare-api',
  url: 'https://mcp.cloudflare.com/mcp',
} as const

export function summarizeCloudflareMcpState(
  state: McpServersState,
): CloudflareMcpStatus {
  const entry = Object.entries(state.servers ?? {}).find(([, server]) =>
    isCloudflareApiMcpServer(server),
  )

  if (!entry) {
    return {
      status: 'not-started',
      message: 'Cloudflare API MCP is not connected for this builder session.',
      serverName: cloudflareApiMcpServer.name,
      serverUrl: cloudflareApiMcpServer.url,
      toolsCount: 0,
    }
  }

  const [serverId, server] = entry
  const toolsCount =
    state.tools?.filter((tool) => tool.serverId === serverId).length ?? 0

  if (server.state === 'ready') {
    return {
      status: 'ready',
      message: `Cloudflare API MCP is ready with ${toolsCount} tools.`,
      serverName: cloudflareApiMcpServer.name,
      serverUrl: cloudflareApiMcpServer.url,
      toolsCount,
    }
  }

  if (server.state === 'authenticating' && server.auth_url) {
    return {
      status: 'authenticating',
      message: 'Authorize Cloudflare API MCP to make Cloudflare tools available.',
      serverName: cloudflareApiMcpServer.name,
      serverUrl: cloudflareApiMcpServer.url,
      authUrl: server.auth_url,
      toolsCount,
    }
  }

  if (server.state === 'failed') {
    return {
      status: 'failed',
      message: server.error || 'Cloudflare API MCP connection failed.',
      serverName: cloudflareApiMcpServer.name,
      serverUrl: cloudflareApiMcpServer.url,
      error: server.error || undefined,
      toolsCount,
    }
  }

  return {
    status: 'connecting',
    message: `Cloudflare API MCP is ${server.state || 'connecting'}.`,
    serverName: cloudflareApiMcpServer.name,
    serverUrl: cloudflareApiMcpServer.url,
    toolsCount,
  }
}

function isCloudflareApiMcpServer(server: McpServerState) {
  return (
    server.name === cloudflareApiMcpServer.name &&
    server.server_url === cloudflareApiMcpServer.url
  )
}
