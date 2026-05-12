import type { AgentPlan } from './agent'
import type { BuildCheckResult } from './build-checks'
import type { BuildPreviewResult } from './build-preview'
import type { CloudflareDeployResult } from './cloudflare-deploy'
import type { CloudflareConnectionStatus } from './cloudflare-status'
import type { DeployApprovalRecord } from './deploy-approval'
import type { GeneratedWorkerApp } from './generated-worker-app'
import type { CodexAuthState } from './model-auth'

export type BuildExecutionStageStatus =
  | 'completed'
  | 'running'
  | 'ready'
  | 'queued'
  | 'blocked'

export type BuildExecutionStage = {
  id: 'plan' | 'generate' | 'preview' | 'checks' | 'approval' | 'deploy'
  title: string
  detail: string
  status: BuildExecutionStageStatus
}

export type BuildExecutionProgress = {
  title: string
  detail: string
  stages: Array<BuildExecutionStage>
}

export function buildExecutionProgress({
  authState,
  checkResult,
  cloudflareStatus,
  deployApproval,
  deployResult,
  generatedApp,
  isPending,
  plan,
  preview,
}: {
  authState: CodexAuthState
  checkResult?: BuildCheckResult
  cloudflareStatus: CloudflareConnectionStatus
  deployApproval?: DeployApprovalRecord
  deployResult?: CloudflareDeployResult
  generatedApp?: GeneratedWorkerApp
  isPending: boolean
  plan?: AgentPlan
  preview?: BuildPreviewResult
}): BuildExecutionProgress {
  if (!plan) {
    return {
      title: 'Waiting for a goal',
      detail:
        'Connect ChatGPT/Codex, describe the Cloudflare web app, then GhostBuild will create the execution path.',
      stages: [
        {
          id: 'plan',
          title: 'Plan Cloudflare app',
          detail: 'No run has started yet.',
          status: isPending ? 'running' : 'queued',
        },
      ],
    }
  }

  const authReady = authState.status === 'connected'
  const cloudflareReady =
    cloudflareStatus.status === 'connected' && Boolean(cloudflareStatus.accountId)
  const approvalReady = Boolean(deployApproval)
  const deployReady = deployResult?.status === 'deployed'
  const generatedReady = Boolean(generatedApp)
  const checksPassed = checkResult?.status === 'passed'
  const previewReady = preview?.status === 'ready'

  return {
    title: plan.deployment.workerName,
    detail: describeCurrentExecutionState({
      approvalReady,
      authReady,
      cloudflareReady,
      isPending,
    }),
    stages: [
      {
        id: 'plan',
        title: 'Plan Cloudflare app',
        detail: 'Goal, stack, session, and deploy target are drafted.',
        status: isPending ? 'running' : 'completed',
      },
      {
        id: 'generate',
        title: 'Generate Worker app',
        detail: generatedApp
          ? `${generatedApp.files.length} Worker app files generated.`
          : 'Next execution step: write the TanStack Start Worker app into the workspace.',
        status: generatedReady ? 'completed' : isPending ? 'queued' : 'ready',
      },
      {
        id: 'preview',
        title: 'Start preview',
        detail: previewReady
          ? `Preview ready at ${preview.url}.`
          : generatedReady
          ? 'Generated files are ready for a local Worker preview run.'
          : 'Preview waits for generated app files and a successful local Worker run.',
        status: previewReady ? 'completed' : checksPassed ? 'ready' : 'queued',
      },
      {
        id: 'checks',
        title: 'Run checks',
        detail: checkResult
          ? `${checkResult.checks.filter((check) => check.status === 'passed').length}/${checkResult.checks.length} artifact checks passed.`
          : 'Typecheck, build, route behavior, and UI checks run before deploy.',
        status: checksPassed ? 'completed' : generatedReady ? 'ready' : 'queued',
      },
      {
        id: 'approval',
        title: 'Record deploy approval',
        detail: approvalReady
          ? `Approval ${deployApproval?.id} recorded.`
          : 'Deployment requires account, Worker name, bindings, cost, and risk confirmation.',
        status: approvalReady ? 'completed' : cloudflareReady ? 'ready' : 'blocked',
      },
      {
        id: 'deploy',
        title: 'Deploy Worker',
        detail: deployReady
          ? `Deployed to Cloudflare as ${deployResult.workerName}.`
          : cloudflareReady
          ? 'Deploy remains blocked until generation, checks, and approval all complete.'
          : 'Connect Cloudflare before deploy can be approved or executed.',
        status:
          deployReady
            ? 'completed'
            : approvalReady && cloudflareReady && checksPassed && previewReady
            ? 'queued'
            : 'blocked',
      },
    ],
  }
}

function describeCurrentExecutionState({
  approvalReady,
  authReady,
  cloudflareReady,
  isPending,
}: {
  approvalReady: boolean
  authReady: boolean
  cloudflareReady: boolean
  isPending: boolean
}) {
  if (isPending) {
    return 'Think is producing the Cloudflare execution plan.'
  }

  if (!authReady) {
    return 'ChatGPT/Codex sign-in is required before the agent can generate code.'
  }

  if (!cloudflareReady) {
    return 'Cloudflare connection is required before deploy approval and deployment.'
  }

  if (!approvalReady) {
    return 'Ready for generation; deploy will stay gated until explicit approval is recorded.'
  }

  return 'Deploy approval is recorded; generation and checks are still required before publishing.'
}
