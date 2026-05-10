import { useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { AgentPlanRequest } from '#/lib/agent'
import { runThinkAgent } from './builderApi'
import { initialAgentRequest } from './builderConstants'
import type { BuilderMessage } from './builderTypes'

export function useBuilderSession() {
  const [request, setRequest] =
    useState<AgentPlanRequest>(initialAgentRequest)
  const [submittedPrompt, setSubmittedPrompt] = useState('')

  const thinkRun = useMutation({
    mutationFn: runThinkAgent,
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
        body:
          thinkRun.data?.summary ??
          'Think is preparing the application plan, workspace, Cloudflare API MCP access, and default Cloudflare Skills.',
      },
    ]
  }, [hasStarted, request.idea, submittedPrompt, thinkRun.data?.summary])

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
