import { Think, type TurnContext } from '@cloudflare/think'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModel } from 'ai'

export const cloudflareApiMcp = {
  name: 'cloudflare-api',
  url: 'https://mcp.cloudflare.com/mcp',
} as const

export type GhostCoderEnv = Cloudflare.Env & {
  GhostCoderAgent: DurableObjectNamespace<GhostCoderAgent>
  OPENAI_API_KEY?: string
}

export class GhostCoderAgent extends Think<GhostCoderEnv> {
  waitForMcpConnections = { timeout: 10_000 }
  maxSteps = 12
  sendReasoning = false

  async onStart() {
    const servers = this.getMcpServers().servers
    const hasCloudflareApi = Object.values(servers).some(
      (server) =>
        server.name === cloudflareApiMcp.name &&
        server.server_url === cloudflareApiMcp.url,
    )

    if (hasCloudflareApi) {
      return
    }

    try {
      await this.addMcpServer(cloudflareApiMcp.name, cloudflareApiMcp.url, {
        transport: { type: 'streamable-http' },
      })
    } catch (error) {
      console.warn('Cloudflare API MCP connection is not ready yet.', error)
    }
  }

  getModel(): LanguageModel {
    if (!this.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is required until browser BYOK is wired.')
    }

    return createOpenAI({ apiKey: this.env.OPENAI_API_KEY })('gpt-5.5')
  }

  getSystemPrompt() {
    return [
      'You are Ghost Coder, a Cloudflare-native coding agent for non-technical users.',
      'Turn product ideas into production-ready Cloudflare Worker applications.',
      'Use Cloudflare Skills and the Cloudflare API MCP server as your default platform context.',
      'Do not use product-specific MCP servers.',
      'Do not expose generated source code unless the user explicitly asks for it.',
      'Never collect or store raw payment card data.',
      'Ask for explicit confirmation before paid or destructive Cloudflare actions.',
      'Default model policy: GPT-5.5 with low reasoning.',
    ].join('\n')
  }

  beforeTurn(_ctx: TurnContext) {
    return {
      providerOptions: {
        openai: {
          reasoningEffort: 'low',
        },
      },
    }
  }
}
