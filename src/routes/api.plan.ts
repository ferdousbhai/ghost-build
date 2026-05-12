import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'
import { RpcTarget } from 'cloudflare:workers'
import { getAgentByName } from 'agents'
import { buildAgentPlan, type AgentPlanRequest } from '#/lib/agent'
import { encodeAgentRunEvent, type AgentRunEvent } from '#/lib/agent-stream'
import { requireAppSession } from '#/lib/app-auth'
import { GhostBuildAgent, type GhostBuildEnv } from '#/lib/ghost-agent'
import { resolveModelRuntimeAuth } from '#/lib/model-auth'
import { readServerOpenAiApiKey } from '#/lib/server-model-auth'

export const Route = createFileRoute('/api/plan')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const payload = (await request.json().catch(() => ({}))) as Partial<
          AgentPlanRequest
        > &
          PlanRunCredentials

        const auth = await requireAppSession(request)

        if (auth.response) {
          return auth.response
        }

        return streamAgentRun({
          ...payload,
          openAiApiKey: readServerOpenAiApiKey(),
        })
      },
    },
  },
})

type PlanRunCredentials = {
  openAiApiKey?: string
}

function streamAgentRun(payload: Partial<AgentPlanRequest> & PlanRunCredentials) {
  const plan = buildAgentPlan(payload)
  const encoder = new TextEncoder()
  const stream = new TransformStream<Uint8Array, Uint8Array>()
  const writer = stream.writable.getWriter()

  void runAgentTurn(payload, plan, (event) =>
    writer.write(encoder.encode(encodeAgentRunEvent(event))),
  )
    .catch((error: unknown) =>
      writer.write(
        encoder.encode(
          encodeAgentRunEvent({
            type: 'error',
            message:
              error instanceof Error
                ? error.message
                : 'The Think agent failed to start.',
            terminal: true,
          }),
        ),
      ),
    )
    .finally(() => writer.close())

  return new Response(stream.readable, {
    headers: {
      'cache-control': 'no-cache',
      'content-type': 'text/event-stream',
    },
  })
}

async function runAgentTurn(
  payload: Partial<AgentPlanRequest> & PlanRunCredentials,
  plan: ReturnType<typeof buildAgentPlan>,
  emit: (event: AgentRunEvent) => Promise<void>,
) {
  const runtimeAuth = resolveModelRuntimeAuth({
    openAiApiKey: payload.openAiApiKey,
  })

  await emit({
    type: 'status',
    message: 'Starting Cloudflare Think agent run.',
  })

  const agent = await getAgentByName<GhostBuildEnv, GhostBuildAgent>(
    (env as GhostBuildEnv).GhostBuildAgent,
    plan.deployment.sessionId,
  )

  await emit({
    type: 'status',
    message: 'Connected durable GhostBuild agent and workspace.',
  })

  await agent.setOpenAiApiKeyForNextTurn(runtimeAuth.apiKey)
  await agent.setReasoningEffortForNextTurn(payload.reasoningEffort ?? 'low')

  const callback = new PlanStreamCallback(emit)
  await agent.chat(formatAgentPrompt(payload), callback)

  if (callback.failed) {
    return
  }

  await emit({
    type: 'completion',
    plan,
    billingSummary: runtimeAuth.billingSummary,
  })
}

function formatAgentPrompt(input: Partial<AgentPlanRequest>) {
  const request = {
    idea: input.idea?.trim() || 'A Cloudflare Worker app',
    audience: input.audience?.trim() || 'non-technical founder',
    deploymentTarget:
      input.deploymentTarget?.trim() || 'Cloudflare Worker',
    model: input.model ?? 'gpt-5.5',
    reasoningEffort: input.reasoningEffort ?? 'low',
  }

  return [
    `Product idea: ${request.idea}`,
    `Audience: ${request.audience}`,
    `Deployment target: ${request.deploymentTarget}`,
    `Model: ${request.model}`,
    'Model auth: GhostBuild server-side OpenAI API key',
    `Reasoning effort: ${request.reasoningEffort}`,
    `Goal: ${input.goal?.objective?.trim() || request.idea}`,
    `Success criteria: ${(input.goal?.successCriteria ?? []).join('; ') || 'derive concrete acceptance checks for the Cloudflare web app'}`,
    '',
    'Create a concise implementation plan for the app.',
    'Use the Cloudflare API MCP server and Cloudflare Skills as available context.',
    'End with the next concrete build action.',
  ].join('\n')
}

class PlanStreamCallback extends RpcTarget {
  failed = false

  constructor(private readonly emit: (event: AgentRunEvent) => Promise<void>) {
    super()
  }

  async onEvent(json: string) {
    await this.emit({
      type: 'transcript_delta',
      message: json,
    })
  }

  async onDone() {
    await this.emit({
      type: 'status',
      message: 'Think agent completed the planning turn.',
    })
  }

  async onError(error: string) {
    this.failed = true
    await this.emit({
      type: 'error',
      message: error,
      terminal: true,
    })
  }
}
