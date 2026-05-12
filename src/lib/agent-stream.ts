import type { AgentPlan } from './agent'

export type AgentRunEvent =
  | {
      type: 'status'
      message: string
      authoritative?: false
    }
  | {
      type: 'transcript_delta'
      message: string
    }
  | {
      type: 'tool_event'
      toolName: string
      message: string
    }
  | {
      type: 'approval_request'
      approvalId: string
      action: string
      resource: string
      risk: 'low' | 'medium' | 'high'
      estimatedCost?: string
    }
  | {
      type: 'completion'
      plan: AgentPlan
      billingSummary: string
    }
  | {
      type: 'error'
      message: string
      terminal: true
    }

export function encodeAgentRunEvent(event: AgentRunEvent) {
  return `data: ${JSON.stringify(event)}\n\n`
}

export function parseAgentRunEvent(event: string): AgentRunEvent | null {
  const dataLine = event
    .split('\n')
    .find((line) => line.startsWith('data: '))

  if (!dataLine) {
    return null
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(dataLine.slice('data: '.length))
  } catch {
    throw new Error('The Think agent returned malformed stream data.')
  }

  if (!isAgentRunEvent(parsed)) {
    throw new Error('The Think agent returned an unknown stream event.')
  }

  return parsed
}

export function isTerminalAgentRunEvent(event: AgentRunEvent) {
  return event.type === 'completion' || event.type === 'error'
}

function isAgentRunEvent(event: unknown): event is AgentRunEvent {
  if (!event || typeof event !== 'object' || !('type' in event)) {
    return false
  }

  const candidate = event as Record<string, unknown>

  if (candidate.type === 'completion') {
    return 'plan' in candidate && typeof candidate.billingSummary === 'string'
  }

  if (candidate.type === 'error') {
    return typeof candidate.message === 'string' && candidate.terminal === true
  }

  if (candidate.type === 'approval_request') {
    return (
      typeof candidate.approvalId === 'string' &&
      typeof candidate.action === 'string' &&
      typeof candidate.resource === 'string'
    )
  }

  if (candidate.type === 'tool_event') {
    return (
      typeof candidate.toolName === 'string' &&
      typeof candidate.message === 'string'
    )
  }

  return (
    (candidate.type === 'status' || candidate.type === 'transcript_delta') &&
    typeof candidate.message === 'string'
  )
}
