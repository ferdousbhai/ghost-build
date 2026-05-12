import type { AgentPlan, AgentPlanRequest } from './agent'
import type { BuildCheckResult } from './build-checks'
import type { BuildPreviewResult } from './build-preview'
import type { CloudflareDeployResult } from './cloudflare-deploy'
import type { DeployApprovalRecord } from './deploy-approval'
import type { GeneratedWorkerApp } from './generated-worker-app'
import type { AppAccountMetadata } from './model-auth'

export type GoalTimelineEntry = {
  role: 'system'
  title: string
  body: string
}

export type BuilderSessionSnapshot = {
  ownerId: string
  request: AgentPlanRequest
  plan: AgentPlan
  submittedPrompt: string
  goalTimeline: Array<GoalTimelineEntry>
  deployApproval?: DeployApprovalRecord
  generatedApp?: GeneratedWorkerApp
  checkResult?: BuildCheckResult
  preview?: BuildPreviewResult
  deployResult?: CloudflareDeployResult
  updatedAt: string
}

export type StoredBuilderSessionSummary = {
  sessionId: string
  projectId: string
  workerName: string
  goal: string
  status: AgentPlan['goal']['status']
  updatedAt: string
}

const serverSessionStore = new Map<string, BuilderSessionSnapshot>()

export function ownerIdFromAppAccount(account?: AppAccountMetadata) {
  return account?.userId || account?.email
}

export function upsertBuilderSessionSnapshot(
  snapshot: BuilderSessionSnapshot,
  store = serverSessionStore,
) {
  store.set(sessionStoreKey(snapshot.ownerId, snapshot.plan.deployment.sessionId), {
    ...snapshot,
    updatedAt: snapshot.updatedAt || new Date().toISOString(),
  })
}

export function listBuilderSessionSnapshots(
  ownerId: string,
  store = serverSessionStore,
) {
  return [...store.values()]
    .filter((snapshot) => snapshot.ownerId === ownerId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

export function getBuilderSessionSnapshot(
  ownerId: string,
  sessionId: string,
  store = serverSessionStore,
) {
  return store.get(sessionStoreKey(ownerId, sessionId))
}

export function summarizeBuilderSessionSnapshot(
  snapshot: BuilderSessionSnapshot,
): StoredBuilderSessionSummary {
  return {
    sessionId: snapshot.plan.deployment.sessionId,
    projectId: snapshot.plan.deployment.projectId,
    workerName: snapshot.plan.deployment.workerName,
    goal: snapshot.plan.goal.objective,
    status: snapshot.plan.goal.status,
    updatedAt: snapshot.updatedAt,
  }
}

function sessionStoreKey(ownerId: string, sessionId: string) {
  return `${ownerId}:${sessionId}`
}
