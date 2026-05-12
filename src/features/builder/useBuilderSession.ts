import { useEffect, useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import {
  evaluateGoalStatus,
  type AgentGoalEvidence,
  type AgentPlan,
  type AgentPlanRequest,
} from '#/lib/agent'
import type { BuildDeployPipelineResult } from '#/lib/build-deploy-pipeline'
import type { BuildCheckResult } from '#/lib/build-checks'
import type { BuildPipelineResult } from '#/lib/build-pipeline'
import type { BuildPreviewResult } from '#/lib/build-preview'
import type { BuildRepairResult } from '#/lib/build-repair'
import type { CloudflareDeployResult } from '#/lib/cloudflare-deploy'
import type {
  BuilderSessionSnapshot,
  GoalTimelineEntry,
  StoredBuilderSessionSummary,
} from '#/lib/builder-session-store'
import type { CloudflareConnectionStatus } from '#/lib/cloudflare-status'
import type { DeployApprovalRecord } from '#/lib/deploy-approval'
import type { AgentPatchResult } from '#/lib/generated-worker-agent-patch'
import type { GeneratedWorkerApp } from '#/lib/generated-worker-app'
import type { CodexAuthState } from '#/lib/model-auth'
import {
  codexAuthChangedEvent,
  isCodexAuthConnected,
  readCodexAuthState,
} from '#/features/auth/localCodexAuth'
import { runThinkAgent } from './builderApi'
import { initialAgentRequest } from './builderConstants'
import type { AgentStreamEvent, BuilderMessage } from './builderTypes'

const initialCodexAuthState: CodexAuthState = {
  mode: 'chatgpt-codex-oauth',
  status: 'disconnected',
  recoveryUrl: '/api/codex-auth/start',
}

const builderSessionStorageKey = 'ghostbuild.builder-session'

const initialCloudflareStatus: CloudflareConnectionStatus = {
  status: 'missing-token',
  permissions: [],
  message: 'Cloudflare account access has not been verified yet.',
}

export function useBuilderSession() {
  const [storedBuilderSession] = useState(readStoredBuilderSession)
  const [request, setRequest] = useState<AgentPlanRequest>(
    () => storedBuilderSession?.request ?? initialAgentRequest,
  )
  const [persistedPlan, setPersistedPlan] = useState<AgentPlan | undefined>(
    () => storedBuilderSession?.plan,
  )
  const [hasCodexSignIn, setHasCodexSignIn] = useState(false)
  const [codexAuthState, setCodexAuthState] = useState<CodexAuthState>(
    initialCodexAuthState,
  )
  const [submittedPrompt, setSubmittedPrompt] = useState('')
  const [goalTimeline, setGoalTimeline] = useState<Array<BuilderMessage>>([])
  const [sessionSummaries, setSessionSummaries] = useState<
    Array<StoredBuilderSessionSummary>
  >([])
  const [cloudflareStatus, setCloudflareStatus] =
    useState<CloudflareConnectionStatus>(initialCloudflareStatus)
  const [deployApproval, setDeployApproval] = useState<
    DeployApprovalRecord | undefined
  >()
  const [generatedApp, setGeneratedApp] = useState<GeneratedWorkerApp | undefined>()
  const [checkResult, setCheckResult] = useState<BuildCheckResult | undefined>()
  const [preview, setPreview] = useState<BuildPreviewResult | undefined>()
  const [deployResult, setDeployResult] = useState<
    CloudflareDeployResult | undefined
  >()
  const [agentStatus, setAgentStatus] = useState(
    'Think is preparing the application plan, workspace, Cloudflare API MCP access, and default Cloudflare Skills.',
  )

  const thinkRun = useMutation({
    mutationFn: (input: AgentPlanRequest) =>
      runThinkAgent(input, handleAgentEvent),
    onSuccess: (plan, variables) => {
      setSubmittedPrompt(variables.idea)
      setPersistedPlan(plan)
      writeStoredBuilderSession({ request: variables, plan })
      void writeServerBuilderSession({
        request: variables,
        plan,
        submittedPrompt: variables.idea,
        goalTimeline: toGoalTimelineEntries(goalTimeline),
        deployApproval,
        deployResult,
        generatedApp,
        checkResult,
        preview,
      })
    },
  })

  useEffect(() => {
    function syncCodexAuthState() {
      void readCodexAuthState().then((authState) => {
        setCodexAuthState(authState)
        setHasCodexSignIn(isCodexAuthConnected(authState))
      })
    }

    syncCodexAuthState()
    window.addEventListener(codexAuthChangedEvent, syncCodexAuthState)
    window.addEventListener('storage', syncCodexAuthState)

    return () => {
      window.removeEventListener(codexAuthChangedEvent, syncCodexAuthState)
      window.removeEventListener('storage', syncCodexAuthState)
    }
  }, [])

  useEffect(() => {
    void refreshCloudflareStatus()
  }, [])

  useEffect(() => {
    if (storedBuilderSession) {
      return
    }

    void loadLatestServerBuilderSession()
  }, [storedBuilderSession])

  const plan = persistedPlan ?? thinkRun.data
  const hasStarted = Boolean(submittedPrompt || thinkRun.isPending || plan)
  const canSubmit =
    request.idea.trim().length > 0 &&
    hasCodexSignIn &&
    !thinkRun.isPending

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
        title: 'GhostBuild',
        body: plan?.summary ?? agentStatus,
      },
      ...goalTimeline,
    ]
  }, [
    agentStatus,
    goalTimeline,
    hasStarted,
    plan?.summary,
    request.idea,
    submittedPrompt,
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
      goal: {
        ...current.goal,
        objective: current.goal?.objective || idea,
      },
    }))
  }

  function updateGoalObjective(objective: string) {
    setRequest((current) => ({
      ...current,
      goal: {
        ...current.goal,
        objective,
      },
    }))
    updatePlanGoal({ objective })
    recordGoalUpdate(
      `Goal updated from "${request.goal?.objective || 'no objective'}" to "${objective || 'no objective'}."`,
    )
  }

  function updateGoalSuccessCriteria(criteria: string) {
    const nextCriteria = criteria
      .split('\n')
      .map((criterion) => criterion.trim())
      .filter(Boolean)

    setRequest((current) => ({
      ...current,
      goal: {
        ...current.goal,
        successCriteria: nextCriteria,
      },
    }))
    updatePlanGoal({ successCriteria: nextCriteria })
    recordGoalUpdate(
      `Goal criteria updated from "${formatCriteria(request.goal?.successCriteria)}" to "${formatCriteria(nextCriteria)}."`,
    )
  }

  function updateProjectSource(projectSource: AgentPlanRequest['projectSource']) {
    setRequest((current) => ({
      ...current,
      projectSource,
    }))
  }

  function updateReasoningEffort(
    reasoningEffort: AgentPlanRequest['reasoningEffort'],
  ) {
    setRequest((current) => ({
      ...current,
      reasoningEffort,
    }))
  }

  function submitPrompt() {
    if (!canSubmit) {
      return
    }

    thinkRun.mutate(request)
  }

  async function refreshCloudflareStatus() {
    try {
      const response = await fetch('/api/cloudflare/status')
      const nextStatus = (await response.json()) as CloudflareConnectionStatus
      setCloudflareStatus(nextStatus)
    } catch {
      setCloudflareStatus({
        status: 'error',
        permissions: [],
        message: 'Unable to verify Cloudflare connection.',
      })
    }
  }

  async function connectCloudflareToken(token: string) {
    const response = await fetch('/api/cloudflare/connect', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ token }),
    })
    const data = (await response.json()) as {
      status?: CloudflareConnectionStatus
      error?: string
    }

    if (!response.ok || !data.status) {
      throw new Error(
        data.error || data.status?.message || 'Unable to connect Cloudflare.',
      )
    }

    setCloudflareStatus(data.status)
  }

  async function requestDeployApproval(input: {
    estimatedCost?: string
    hasDestructiveAction: boolean
    hasPaidAction: boolean
  }) {
    if (!plan || cloudflareStatus.status !== 'connected') {
      return
    }

    const response = await fetch('/api/deploy/approval', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        accountId: cloudflareStatus.accountId,
        accountName: cloudflareStatus.accountName,
        bindings: plan.deployment.bindings,
        confirmedBy:
          codexAuthState.status === 'connected'
            ? codexAuthState.account?.email || 'Codex account'
            : 'Unknown user',
        estimatedCost: input.estimatedCost,
        hasDestructiveAction: input.hasDestructiveAction,
        hasPaidAction: input.hasPaidAction,
        workerName: plan.deployment.workerName,
      }),
    })

    if (!response.ok) {
      throw new Error('Unable to create deploy approval.')
    }

    const data = (await response.json()) as {
      approval: DeployApprovalRecord
    }
    setDeployApproval(data.approval)
    void persistCurrentServerSession({
      deployApproval: data.approval,
    })
  }

  async function generateWorkerApp() {
    if (!plan) {
      return
    }

    const response = await fetch('/api/build/generate', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ plan }),
    })
    const data = (await response.json()) as {
      generatedApp?: GeneratedWorkerApp
      error?: string
    }

    if (!response.ok || !data.generatedApp) {
      throw new Error(data.error || 'Unable to generate Worker app files.')
    }

    setGeneratedApp(data.generatedApp)
    setCheckResult(undefined)
    setPreview(undefined)
    setDeployResult(undefined)
    const nextPlan = updatePlanGoalStatus({
      generatedApp: data.generatedApp,
      checkResult: undefined,
      preview: undefined,
      deployResult: undefined,
    })
    void persistCurrentServerSession({
      plan: nextPlan,
      generatedApp: data.generatedApp,
      checkResult: undefined,
      preview: undefined,
      deployResult: undefined,
    })
  }

  async function runBuildPipeline() {
    if (!plan) {
      return
    }

    const response = await fetch('/api/build/run', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ plan }),
    })
    const data = (await response.json()) as {
      pipeline?: BuildPipelineResult
      error?: string
    }

    if (!response.ok || !data.pipeline) {
      throw new Error(data.error || 'Unable to run Worker build pipeline.')
    }

    setGeneratedApp(data.pipeline.generatedApp)
    setCheckResult(data.pipeline.checkResult)
    setPreview(data.pipeline.preview)
    setDeployResult(undefined)
    const nextPlan = updatePlanGoalStatus({
      generatedApp: data.pipeline.generatedApp,
      checkResult: data.pipeline.checkResult,
      preview: data.pipeline.preview,
      deployResult: undefined,
    })
    void persistCurrentServerSession({
      plan: nextPlan,
      generatedApp: data.pipeline.generatedApp,
      checkResult: data.pipeline.checkResult,
      preview: data.pipeline.preview,
      deployResult: undefined,
    })
  }

  async function runBuildChecks() {
    if (!generatedApp) {
      return
    }

    const response = await fetch('/api/build/checks', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ generatedApp }),
    })
    const data = (await response.json()) as {
      checkResult?: BuildCheckResult
      error?: string
    }

    if (!response.ok || !data.checkResult) {
      throw new Error(data.error || 'Unable to run Worker app checks.')
    }

    setCheckResult(data.checkResult)
    setPreview(undefined)
    setDeployResult(undefined)
    const nextPlan = updatePlanGoalStatus({
      checkResult: data.checkResult,
      preview: undefined,
      deployResult: undefined,
    })
    void persistCurrentServerSession({
      plan: nextPlan,
      checkResult: data.checkResult,
      preview: undefined,
      deployResult: undefined,
    })
  }

  async function repairGeneratedApp() {
    if (!plan || !generatedApp || !checkResult) {
      return
    }

    const response = await fetch('/api/build/repair', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ checkResult, generatedApp, plan }),
    })
    const data = (await response.json()) as {
      repairResult?: BuildRepairResult
      error?: string
    }

    if (!response.ok || !data.repairResult) {
      throw new Error(data.error || 'Unable to repair Worker app files.')
    }

    setGeneratedApp(data.repairResult.repairedApp)
    setCheckResult(undefined)
    setPreview(undefined)
    setDeployResult(undefined)
    const nextPlan = updatePlanGoalStatus({
      generatedApp: data.repairResult.repairedApp,
      checkResult: undefined,
      preview: undefined,
      deployResult: undefined,
    })
    void persistCurrentServerSession({
      plan: nextPlan,
      generatedApp: data.repairResult.repairedApp,
      checkResult: undefined,
      preview: undefined,
      deployResult: undefined,
    })
  }

  async function requestAgentPatch() {
    if (!plan || !generatedApp || !checkResult) {
      return
    }

    const response = await fetch('/api/build/agent-patch', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        checkResult,
        generatedApp,
        goal: plan.goal.objective,
      }),
    })
    const data = (await response.json()) as {
      patchResult?: AgentPatchResult
      error?: string
    }

    if (!response.ok || !data.patchResult) {
      throw new Error(data.error || 'Unable to patch Worker app files.')
    }

    setGeneratedApp(data.patchResult.patchedApp)
    setCheckResult(undefined)
    setPreview(undefined)
    setDeployResult(undefined)
    const nextPlan = updatePlanGoalStatus({
      generatedApp: data.patchResult.patchedApp,
      checkResult: undefined,
      preview: undefined,
      deployResult: undefined,
    })
    void persistCurrentServerSession({
      plan: nextPlan,
      generatedApp: data.patchResult.patchedApp,
      checkResult: undefined,
      preview: undefined,
      deployResult: undefined,
    })
  }

  async function prepareBuildPreview() {
    if (!generatedApp || !checkResult) {
      return
    }

    const response = await fetch('/api/build/preview', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ checkResult, generatedApp }),
    })
    const data = (await response.json()) as {
      error?: string
      preview?: BuildPreviewResult
    }

    if (!response.ok || !data.preview) {
      throw new Error(data.error || 'Unable to prepare Worker preview.')
    }

    setPreview(data.preview)
    setDeployResult(undefined)
    const nextPlan = updatePlanGoalStatus({
      preview: data.preview,
      deployResult: undefined,
    })
    void persistCurrentServerSession({
      plan: nextPlan,
      preview: data.preview,
      deployResult: undefined,
    })
  }

  async function deployWorkerApp() {
    if (!plan || !generatedApp || !checkResult || !preview || !deployApproval) {
      return
    }

    const response = await fetch('/api/deploy/worker', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        approval: deployApproval,
        checkResult,
        generatedApp,
        plan,
        preview,
      }),
    })
    const data = (await response.json()) as {
      deployResult?: CloudflareDeployResult
      error?: string
    }

    if (!response.ok || !data.deployResult) {
      throw new Error(data.error || 'Unable to deploy Worker.')
    }

    setDeployResult(data.deployResult)
    const nextPlan = updatePlanGoalStatus({
      deployResult: data.deployResult,
    })
    void persistCurrentServerSession({
      plan: nextPlan,
      deployResult: data.deployResult,
    })
  }

  async function runBuildDeployPipeline() {
    if (!plan || !deployApproval) {
      return
    }

    const response = await fetch('/api/deploy/run', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        approval: deployApproval,
        plan,
      }),
    })
    const data = (await response.json()) as {
      pipeline?: BuildDeployPipelineResult
      error?: string
    }

    if (!response.ok || !data.pipeline) {
      throw new Error(data.error || 'Unable to run build and deploy pipeline.')
    }

    setGeneratedApp(data.pipeline.generatedApp)
    setCheckResult(data.pipeline.checkResult)
    setPreview(data.pipeline.preview)
    setDeployResult(data.pipeline.deployResult)
    const nextPlan = updatePlanGoalStatus({
      generatedApp: data.pipeline.generatedApp,
      checkResult: data.pipeline.checkResult,
      preview: data.pipeline.preview,
      deployResult: data.pipeline.deployResult,
    })
    void persistCurrentServerSession({
      plan: nextPlan,
      generatedApp: data.pipeline.generatedApp,
      checkResult: data.pipeline.checkResult,
      preview: data.pipeline.preview,
      deployResult: data.pipeline.deployResult,
    })
  }

  function updatePlanGoal(
    goal: Partial<Pick<AgentPlan['goal'], 'objective' | 'successCriteria'>>,
  ) {
    if (!plan) {
      return undefined
    }

    const nextPlan = {
      ...plan,
      goal: {
        ...plan.goal,
        ...goal,
        status: evaluateGoalStatus(
          goal.successCriteria ?? plan.goal.successCriteria,
          buildGoalEvidence(),
        ),
      },
    }

    setPersistedPlan(nextPlan)
    writeStoredBuilderSession({ request, plan: nextPlan })
    void persistCurrentServerSession({ plan: nextPlan })

    return nextPlan
  }

  function updatePlanGoalStatus(
    overrides: Partial<
      Pick<
        BuilderSessionSnapshot,
        'checkResult' | 'deployResult' | 'generatedApp' | 'preview'
      >
    > = {},
  ) {
    if (!plan) {
      return undefined
    }

    const status = evaluateGoalStatus(
      plan.goal.successCriteria,
      buildGoalEvidence(overrides),
    )

    if (status === plan.goal.status) {
      return plan
    }

    const nextPlan = {
      ...plan,
      goal: {
        ...plan.goal,
        status,
      },
    }

    setPersistedPlan(nextPlan)
    writeStoredBuilderSession({ request, plan: nextPlan })
    recordGoalUpdate(`Goal status changed from "${plan.goal.status}" to "${status}".`)

    return nextPlan
  }

  function buildGoalEvidence(
    overrides: Partial<
      Pick<
        BuilderSessionSnapshot,
        'checkResult' | 'deployResult' | 'generatedApp' | 'preview'
      >
    > = {},
  ): AgentGoalEvidence {
    const nextGeneratedApp =
      'generatedApp' in overrides ? overrides.generatedApp : generatedApp
    const nextCheckResult =
      'checkResult' in overrides ? overrides.checkResult : checkResult
    const nextPreview = 'preview' in overrides ? overrides.preview : preview
    const nextDeployResult =
      'deployResult' in overrides ? overrides.deployResult : deployResult
    const blockers =
      nextCheckResult?.status === 'failed'
        ? nextCheckResult.checks
            .filter((check) => check.status === 'failed')
            .map((check) => check.detail)
        : undefined

    return {
      generated: Boolean(nextGeneratedApp),
      checksPassed: nextCheckResult?.status === 'passed',
      previewReady: nextPreview?.status === 'ready',
      deployed: nextDeployResult?.status === 'deployed',
      deploymentUrl: nextDeployResult?.dashboardUrl,
      blockers,
    }
  }

  function recordGoalUpdate(body: string) {
    if (!hasStarted) {
      return
    }

    setGoalTimeline((current) => {
      const nextTimeline =
        current.at(-1)?.body === body
          ? current
          : [
              ...current,
              {
                role: 'system' as const,
                title: `Goal update ${current.length + 1}`,
                body,
              },
            ]

      void persistCurrentServerSession({
        goalTimeline: toGoalTimelineEntries(nextTimeline),
      })

      return nextTimeline
    })
  }

  async function loadLatestServerBuilderSession() {
    try {
      const response = await fetch('/api/builder-sessions')

      if (!response.ok) {
        return
      }

      const data = (await response.json()) as {
        latest?: BuilderSessionSnapshot
        sessions?: Array<StoredBuilderSessionSummary>
      }

      setSessionSummaries(data.sessions ?? [])

      if (!data.latest) {
        return
      }

      applyBuilderSessionSnapshot(data.latest)
    } catch {
      // Browser-local state remains the fallback when server session load fails.
    }
  }

  async function loadBuilderSession(sessionId: string) {
    const response = await fetch(
      `/api/builder-sessions?sessionId=${encodeURIComponent(sessionId)}`,
    )

    if (!response.ok) {
      return
    }

    const data = (await response.json()) as {
      latest?: BuilderSessionSnapshot
      sessions?: Array<StoredBuilderSessionSummary>
    }

    setSessionSummaries(data.sessions ?? [])

    if (data.latest) {
      applyBuilderSessionSnapshot(data.latest)
    }
  }

  function applyBuilderSessionSnapshot(snapshot: BuilderSessionSnapshot) {
    setRequest(snapshot.request)
    setPersistedPlan(snapshot.plan)
    setSubmittedPrompt(snapshot.submittedPrompt)
    setGoalTimeline(snapshot.goalTimeline)
    setDeployApproval(snapshot.deployApproval)
    setGeneratedApp(snapshot.generatedApp)
    setCheckResult(snapshot.checkResult)
    setPreview(snapshot.preview)
    setDeployResult(snapshot.deployResult)
    writeStoredBuilderSession({
      request: snapshot.request,
      plan: snapshot.plan,
    })
  }

  function persistCurrentServerSession(
    overrides: Partial<
      Pick<
        BuilderSessionSnapshot,
        | 'checkResult'
        | 'deployApproval'
        | 'deployResult'
        | 'generatedApp'
        | 'goalTimeline'
        | 'preview'
      >
    > & {
      plan?: AgentPlan
    } = {},
  ) {
    const snapshotPlan = overrides.plan ?? plan

    if (!snapshotPlan) {
      return
    }

    return writeServerBuilderSession({
      request,
      plan: snapshotPlan,
      submittedPrompt: submittedPrompt || request.idea,
      goalTimeline: toGoalTimelineEntries(overrides.goalTimeline ?? goalTimeline),
      deployApproval: valueFromOverride(overrides, 'deployApproval', deployApproval),
      deployResult: valueFromOverride(overrides, 'deployResult', deployResult),
      generatedApp: valueFromOverride(overrides, 'generatedApp', generatedApp),
      checkResult: valueFromOverride(overrides, 'checkResult', checkResult),
      preview: valueFromOverride(overrides, 'preview', preview),
    })
  }

  return {
    canSubmit,
    checkResult,
    cloudflareStatus,
    codexAuthState,
    deployApproval,
    deployResult,
    generatedApp,
    hasCodexSignIn,
    hasStarted,
    isPending: thinkRun.isPending,
    messages,
    plan,
    preview,
    request,
    sessionSummaries,
    connectCloudflareToken,
    deployWorkerApp,
    generateWorkerApp,
    prepareBuildPreview,
    loadBuilderSession,
    requestDeployApproval,
    requestAgentPatch,
    repairGeneratedApp,
    refreshCloudflareStatus,
    runBuildDeployPipeline,
    runBuildPipeline,
    runBuildChecks,
    submitPrompt,
    updateIdea,
    updateGoalObjective,
    updateGoalSuccessCriteria,
    updateProjectSource,
    updateReasoningEffort,
  }
}

function formatCriteria(criteria?: Array<string>) {
  if (!criteria?.length) {
    return 'no criteria'
  }

  return criteria.join('; ')
}

function toGoalTimelineEntries(entries: Array<BuilderMessage>) {
  return entries.filter((entry) => entry.role === 'system') as Array<
    GoalTimelineEntry
  >
}

function readStoredBuilderSession() {
  if (typeof window === 'undefined') {
    return undefined
  }

  try {
    const value = window.localStorage.getItem(builderSessionStorageKey)

    if (!value) {
      return undefined
    }

    return JSON.parse(value) as {
      request: AgentPlanRequest
      plan?: AgentPlan
    }
  } catch {
    return undefined
  }
}

function writeStoredBuilderSession(session: {
  request: AgentPlanRequest
  plan: AgentPlan
}) {
  window.localStorage.setItem(builderSessionStorageKey, JSON.stringify(session))
}

async function writeServerBuilderSession(
  snapshot: Omit<BuilderSessionSnapshot, 'ownerId' | 'updatedAt'>,
) {
  await fetch('/api/builder-sessions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(snapshot),
  }).catch(() => undefined)
}

function valueFromOverride<
  TObject extends object,
  TKey extends keyof TObject,
  TFallback,
>(overrides: TObject, key: TKey, fallback: TFallback) {
  return key in overrides ? overrides[key] : fallback
}
