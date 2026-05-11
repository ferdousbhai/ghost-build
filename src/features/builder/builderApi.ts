import type { AgentPlan, AgentPlanRequest } from '#/lib/agent'
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
    throw new Error('Unable to start the Think agent')
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
      const data = parseServerSentEvent(event)

      if (!data) {
        continue
      }

      if (isDoneEvent(data)) {
        plan = data.plan
        onEvent?.({ type: 'done' })
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

type PlanResponseEvent =
  | AgentStreamEvent
  | {
      type: 'done'
      plan: AgentPlan
    }

function parseServerSentEvent(event: string): PlanResponseEvent | null {
  const dataLine = event
    .split('\n')
    .find((line) => line.startsWith('data: '))

  if (!dataLine) {
    return null
  }

  return JSON.parse(dataLine.slice('data: '.length)) as PlanResponseEvent
}

function isDoneEvent(
  event: PlanResponseEvent,
): event is { type: 'done'; plan: AgentPlan } {
  return event.type === 'done' && 'plan' in event
}
