import { Think, type TurnContext } from '@cloudflare/think'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModel } from 'ai'
import type { ReasoningEffort } from './agent'
import {
  cloudflareApiMcpServer,
  summarizeCloudflareMcpState,
  type CloudflareMcpStatus,
} from './cloudflare-mcp'
import {
  getBuilderSessionSnapshot,
  listBuilderSessionSnapshots,
  summarizeBuilderSessionSnapshot,
  upsertBuilderSessionSnapshot,
  type BuilderSessionSnapshot,
  type StoredBuilderSessionSummary,
} from './builder-session-store'

export const cloudflareApiMcp = cloudflareApiMcpServer

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
    this.mcp.configureOAuthCallback({
      customHandler: () =>
        new Response('<script>window.close();</script>', {
          headers: { 'content-type': 'text/html' },
        }),
    })
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

  async connectCloudflareApiMcp(callbackHost: string): Promise<CloudflareMcpStatus> {
    try {
      const result = await this.addMcpServer(
        cloudflareApiMcp.name,
        cloudflareApiMcp.url,
        {
          callbackHost,
          transport: { type: 'streamable-http' },
        },
      )

      if (result.state === 'authenticating') {
        return {
          status: 'authenticating',
          message: 'Authorize Cloudflare API MCP to make Cloudflare tools available.',
          serverName: cloudflareApiMcp.name,
          serverUrl: cloudflareApiMcp.url,
          authUrl: result.authUrl,
          toolsCount: 0,
        }
      }

      return this.getCloudflareApiMcpStatus()
    } catch (error) {
      return {
        status: 'failed',
        message:
          error instanceof Error
            ? error.message
            : 'Cloudflare API MCP connection failed.',
        serverName: cloudflareApiMcp.name,
        serverUrl: cloudflareApiMcp.url,
        error: error instanceof Error ? error.message : undefined,
        toolsCount: 0,
      }
    }
  }

  getCloudflareApiMcpStatus(): CloudflareMcpStatus {
    return summarizeCloudflareMcpState(this.getMcpServers())
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
