import type { AgentPlan, AgentPlanRequest } from '#/lib/agent'

export async function runThinkAgent(
  request: AgentPlanRequest,
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

  return response.json()
}
