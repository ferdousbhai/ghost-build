import type { AgentPlan, AgentPlanRequest } from '#/lib/agent'
import { parseAgentRunEvent } from '#/lib/agent-stream'
import type { AgentStreamEvent } from './builderTypes'

export async function runThinkAgent(
  request: AgentPlanRequest,
  onEvent?: (event: AgentStreamEvent) => void,
): Promise<AgentPlan> {
  const response = await fetch('/api/plan', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(request),
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response))
  }

  if (!response.body) {
    throw new Error('The Think agent did not return a stream')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let plan: AgentPlan | undefined

  while (true) {
    const { done, value } = await reader.read()

    if (done) {
      break
    }

    buffer += decoder.decode(value, { stream: true })
    const events = buffer.split('\n\n')
    buffer = events.pop() ?? ''

    for (const event of events) {
      const data = parseAgentRunEvent(event)

      if (!data) {
        continue
      }

      if (data.type === 'completion') {
        plan = data.plan
        onEvent?.({
          type: 'completion',
          billingSummary: data.billingSummary,
        })
        continue
      }

      onEvent?.(data)

      if (data.type === 'error') {
        throw new Error(data.message)
      }
    }
  }

  if (!plan) {
    throw new Error('The Think agent finished without a plan')
  }

  return plan
}

async function readErrorMessage(response: Response) {
  const fallback = 'Unable to start the Think agent'

  try {
    const data = (await response.json()) as { error?: string }
    return data.error || fallback
  } catch {
    return fallback
  }
}
