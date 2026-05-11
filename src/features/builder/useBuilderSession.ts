import { useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { AgentPlanRequest } from '#/lib/agent'
import { runThinkAgent } from './builderApi'
import { initialAgentRequest } from './builderConstants'
import type { AgentStreamEvent, BuilderMessage } from './builderTypes'

export function useBuilderSession() {
  const [request, setRequest] =
    useState<AgentPlanRequest>(initialAgentRequest)
  const [submittedPrompt, setSubmittedPrompt] = useState('')
  const [agentStatus, setAgentStatus] = useState(
    'Think is preparing the application plan, workspace, Cloudflare API MCP access, and default Cloudflare Skills.',
  )

  const thinkRun = useMutation({
    mutationFn: (input: AgentPlanRequest) =>
      runThinkAgent(input, handleAgentEvent),
    onSuccess: (_plan, variables) => {
      setSubmittedPrompt(variables.idea)
    },
  })

  const hasStarted = Boolean(submittedPrompt || thinkRun.isPending)
  const canSubmit = request.idea.trim().length > 0 && !thinkRun.isPending

  const messages = useMemo<Array<BuilderMessage>>(() => {
    if (!hasStarted) {
      return []
    }

    return [
      {
        role: 'user',
        title: 'You',
        body: submittedPrompt || request.idea,
      },
      {
        role: 'assistant',
        title: 'Ghost Coder',
        body: thinkRun.data?.summary ?? agentStatus,
      },
    ]
  }, [
    agentStatus,
    hasStarted,
    request.idea,
    submittedPrompt,
    thinkRun.data?.summary,
  ])

  function handleAgentEvent(event: AgentStreamEvent) {
    if (event.type === 'status') {
      setAgentStatus(event.message)
    }

    if (event.type === 'error') {
      setAgentStatus(event.message)
    }
  }

  function updateIdea(idea: string) {
    setRequest((current) => ({
      ...current,
      idea,
    }))
  }

  function submitPrompt() {
    if (!canSubmit) {
      return
    }

    thinkRun.mutate(request)
  }

  return {
    canSubmit,
    hasStarted,
    isPending: thinkRun.isPending,
    messages,
    plan: thinkRun.data,
    request,
    submitPrompt,
    updateIdea,
  }
}
