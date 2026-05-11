import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'
import { RpcTarget } from 'cloudflare:workers'
import { getAgentByName } from 'agents'
import { buildAgentPlan, type AgentPlanRequest } from '#/lib/agent'
import { GhostCoderAgent, type GhostCoderEnv } from '#/lib/ghost-agent'

export const Route = createFileRoute('/api/plan')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const payload = (await request.json().catch(() => ({}))) as Partial<
          AgentPlanRequest
        >
        return streamAgentRun(payload)
      },
    },
  },
})

type PlanStreamEvent =
  | {
      type: 'status'
      message: string
    }
  | {
      type: 'chunk'
      message: string
    }
  | {
      type: 'done'
      plan: ReturnType<typeof buildAgentPlan>
    }
  | {
      type: 'error'
      message: string
    }

function streamAgentRun(payload: Partial<AgentPlanRequest>) {
  const plan = buildAgentPlan(payload)
  const encoder = new TextEncoder()
  const stream = new TransformStream<Uint8Array, Uint8Array>()
  const writer = stream.writable.getWriter()

  void runAgentTurn(payload, plan, (event) =>
    writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)),
  )
    .catch((error: unknown) =>
      writer.write(
        encoder.encode(
          `data: ${JSON.stringify({
            type: 'error',
            message:
              error instanceof Error
                ? error.message
                : 'The Think agent failed to start.',
          } satisfies PlanStreamEvent)}\n\n`,
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
  payload: Partial<AgentPlanRequest>,
  plan: ReturnType<typeof buildAgentPlan>,
  emit: (event: PlanStreamEvent) => Promise<void>,
) {
  await emit({
    type: 'status',
    message: 'Starting Cloudflare Think agent run.',
  })

  const agent = await getAgentByName<GhostCoderEnv, GhostCoderAgent>(
    (env as GhostCoderEnv).GhostCoderAgent,
    plan.deployment.workerName,
  )

  await emit({
    type: 'status',
    message: 'Connected durable Ghost Coder agent and workspace.',
  })

  const callback = new PlanStreamCallback(emit)
  await agent.chat(formatAgentPrompt(payload), callback)

  if (callback.failed) {
    return
  }

  await emit({
    type: 'done',
    plan,
  })
}

function formatAgentPrompt(input: Partial<AgentPlanRequest>) {
  const request = {
    idea: input.idea?.trim() || 'A Cloudflare Worker app',
    audience: input.audience?.trim() || 'non-technical founder',
    deploymentTarget:
      input.deploymentTarget?.trim() || 'Cloudflare Worker',
  }

  return [
    `Product idea: ${request.idea}`,
    `Audience: ${request.audience}`,
    `Deployment target: ${request.deploymentTarget}`,
    '',
    'Create a concise implementation plan for the app.',
    'Use the Cloudflare API MCP server and Cloudflare Skills as available context.',
    'End with the next concrete build action.',
  ].join('\n')
}

class PlanStreamCallback extends RpcTarget {
  failed = false

  constructor(private readonly emit: (event: PlanStreamEvent) => Promise<void>) {
    super()
  }

  async onEvent(json: string) {
    await this.emit({
      type: 'chunk',
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
    })
  }
}
