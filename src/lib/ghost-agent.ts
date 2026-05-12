import { Think, type TurnContext } from '@cloudflare/think'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModel } from 'ai'
import type { ReasoningEffort } from './agent'
import {
  getBuilderSessionSnapshot,
  listBuilderSessionSnapshots,
  summarizeBuilderSessionSnapshot,
  upsertBuilderSessionSnapshot,
  type BuilderSessionSnapshot,
  type StoredBuilderSessionSummary,
} from './builder-session-store'

export const cloudflareApiMcp = {
  name: 'cloudflare-api',
  url: 'https://mcp.cloudflare.com/mcp',
} as const

export type GhostBuildEnv = Cloudflare.Env & {
  GhostBuildAgent: DurableObjectNamespace<GhostBuildAgent>
}

export type GhostBuildState = {
  builderSessions: Record<string, BuilderSessionSnapshot>
}

export class GhostBuildAgent extends Think<GhostBuildEnv, GhostBuildState> {
  initialState: GhostBuildState = {
    builderSessions: {},
  }
  waitForMcpConnections = { timeout: 10_000 }
  maxSteps = 12
  sendReasoning = false
  private codexOAuthTokenForNextTurn = ''
  private reasoningEffortForNextTurn: ReasoningEffort = 'low'

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
    const apiKey = this.codexOAuthTokenForNextTurn
    this.codexOAuthTokenForNextTurn = ''

    if (!apiKey) {
      throw new Error('ChatGPT/Codex sign-in is required for this run.')
    }

    return createOpenAI({ apiKey })('gpt-5.5')
  }

  setCodexOAuthTokenForNextTurn(accessToken: string) {
    this.codexOAuthTokenForNextTurn = accessToken.trim()
  }

  setReasoningEffortForNextTurn(reasoningEffort: ReasoningEffort) {
    this.reasoningEffortForNextTurn = reasoningEffort
  }

  saveBuilderSessionSnapshot(snapshot: BuilderSessionSnapshot) {
    const sessions = new Map(Object.entries(this.state.builderSessions ?? {}))

    upsertBuilderSessionSnapshot(snapshot, sessions)
    this.setState({
      ...this.state,
      builderSessions: Object.fromEntries(sessions),
    })

    return summarizeBuilderSessionSnapshot(snapshot)
  }

  listBuilderSessionSnapshots(ownerId: string) {
    return listBuilderSessionSnapshots(
      ownerId,
      new Map(Object.entries(this.state.builderSessions ?? {})),
    )
  }

  getBuilderSessionSnapshot(ownerId: string, sessionId: string) {
    return getBuilderSessionSnapshot(
      ownerId,
      sessionId,
      new Map(Object.entries(this.state.builderSessions ?? {})),
    )
  }

  listBuilderSessionSummaries(ownerId: string): Array<StoredBuilderSessionSummary> {
    return this.listBuilderSessionSnapshots(ownerId).map(
      summarizeBuilderSessionSnapshot,
    )
  }

  getSystemPrompt() {
    return [
      'You are GhostBuild, a goal-driven Cloudflare-native web app builder.',
      'Your product focus is narrower than a general coding agent: build, preview, and deploy web applications on the full Cloudflare stack.',
      'Target users may be less experienced developers, so keep decisions concrete, explain tradeoffs plainly, and avoid exposing source code unless the user asks.',
      'At the start of every turn, interpret the user request as a possible goal update.',
      'Maintain an active goal with objective, success criteria, current status, and the next concrete Cloudflare build step.',
      'If the user changes scope, update the goal before planning implementation work.',
      'Prefer Cloudflare Workers, TanStack Start, Durable Objects, D1, R2, KV, Queues, Workers AI, AI Gateway, and Cloudflare-managed auth/payment/deploy flows where they fit.',
      'Use Cloudflare Skills and the Cloudflare API MCP server as default platform context.',
      'Do not use product-specific MCP servers.',
      'Never collect or store raw payment card data.',
      'Ask for explicit confirmation before paid or destructive Cloudflare actions.',
      'Default model policy: GPT-5.5 with low reasoning.',
    ].join('\n')
  }

  beforeTurn(_ctx: TurnContext) {
    const reasoningEffort = this.reasoningEffortForNextTurn
    this.reasoningEffortForNextTurn = 'low'

    return {
      providerOptions: {
        openai: {
          reasoningEffort,
        },
      },
    }
  }
}
