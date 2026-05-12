import { CheckCircle2, Globe2, Loader2, LockKeyhole, Rocket, Square } from 'lucide-react'
import { useState } from 'react'
import type { AgentPlan } from '#/lib/agent'
import type { BuildCheckResult } from '#/lib/build-checks'
import type { BuildPreviewResult } from '#/lib/build-preview'
import type { CloudflareDeployResult } from '#/lib/cloudflare-deploy'
import type { CloudflareMcpStatus } from '#/lib/cloudflare-mcp'
import { buildExecutionProgress, type BuildExecutionStageStatus } from '#/lib/build-execution'
import {
  hasWorkersWritePermission,
  type CloudflareConnectionStatus,
} from '#/lib/cloudflare-status'
import type { DeployApprovalRecord } from '#/lib/deploy-approval'
import type { GeneratedWorkerApp } from '#/lib/generated-worker-app'
import type { CodexAuthState } from '#/lib/model-auth'
import type { StripeProjectsConnectionStatus } from '#/lib/stripe-projects'
import {
  defaultCapabilities,
  cloudflareStackReadiness,
  ownershipLineItems,
  productionSteps,
} from './builderConstants'

type PreviewPaneProps = {
  cloudflareStatus: CloudflareConnectionStatus
  cloudflareMcpStatus?: CloudflareMcpStatus
  codexAuthState: CodexAuthState
  stripeProjectsStatus?: StripeProjectsConnectionStatus
  checkResult?: BuildCheckResult
  deployApproval?: DeployApprovalRecord
  deployResult?: CloudflareDeployResult
  generatedApp?: GeneratedWorkerApp
  isPending: boolean
  plan?: AgentPlan
  preview?: BuildPreviewResult
  onConnectCloudflareToken: (token: string) => Promise<void>
  onConnectCloudflareMcp?: () => Promise<void>
  onConnectStripeProjects?: () => Promise<void>
  onDeployWorkerApp?: () => Promise<void>
  onGenerateWorkerApp: () => Promise<void>
  onPrepareBuildPreview: () => Promise<void>
  onRequestAgentPatch?: () => Promise<void>
  onRequestDeployApproval: (input: {
    estimatedCost?: string
    hasDestructiveAction: boolean
    hasPaidAction: boolean
  }) => Promise<void>
  onRepairGeneratedApp?: () => Promise<void>
  onRunBuildDeployPipeline?: () => Promise<void>
  onRunBuildPipeline?: () => Promise<void>
  onRunBuildChecks: () => Promise<void>
}

export function PreviewPane({
  cloudflareStatus,
  cloudflareMcpStatus = initialCloudflareMcpStatus,
  codexAuthState,
  stripeProjectsStatus = initialStripeProjectsStatus,
  checkResult,
  deployApproval,
  deployResult,
  generatedApp,
  isPending,
  plan,
  preview,
  onConnectCloudflareToken,
  onConnectCloudflareMcp = async () => undefined,
  onConnectStripeProjects = async () => undefined,
  onDeployWorkerApp = async () => undefined,
  onGenerateWorkerApp,
  onPrepareBuildPreview,
  onRequestAgentPatch = async () => undefined,
  onRequestDeployApproval,
  onRepairGeneratedApp = async () => undefined,
  onRunBuildDeployPipeline = async () => undefined,
  onRunBuildPipeline = async () => undefined,
  onRunBuildChecks,
}: PreviewPaneProps) {
  const [deployApprovalRequested, setDeployApprovalRequested] = useState(false)
  const [isApprovingDeploy, setIsApprovingDeploy] = useState(false)
  const [cloudflareToken, setCloudflareToken] = useState('')
  const [cloudflareConnectError, setCloudflareConnectError] = useState('')
  const [isConnectingCloudflare, setIsConnectingCloudflare] = useState(false)
  const [isConnectingCloudflareMcp, setIsConnectingCloudflareMcp] = useState(false)
  const [cloudflareMcpError, setCloudflareMcpError] = useState('')
  const [isConnectingStripeProjects, setIsConnectingStripeProjects] =
    useState(false)
  const [stripeProjectsError, setStripeProjectsError] = useState('')
  const [estimatedCost, setEstimatedCost] = useState(
    'No additional Cloudflare cost expected',
  )
  const [hasPaidAction, setHasPaidAction] = useState(false)
  const [hasDestructiveAction, setHasDestructiveAction] = useState(false)
  const [isGeneratingWorker, setIsGeneratingWorker] = useState(false)
  const [isRunningChecks, setIsRunningChecks] = useState(false)
  const [isRepairingWorker, setIsRepairingWorker] = useState(false)
  const [isRunningPipeline, setIsRunningPipeline] = useState(false)
  const [isRunningDeployPipeline, setIsRunningDeployPipeline] = useState(false)
  const [isPreparingPreview, setIsPreparingPreview] = useState(false)
  const [isRequestingAgentPatch, setIsRequestingAgentPatch] = useState(false)
  const [isDeployingWorker, setIsDeployingWorker] = useState(false)
  const readinessItems = buildReadinessItems(
    codexAuthState,
    Boolean(plan),
    cloudflareStatus,
    deployApproval,
  )
  const executionProgress = buildExecutionProgress({
    authState: codexAuthState,
    checkResult,
    cloudflareStatus,
    deployApproval,
    deployResult,
    generatedApp,
    isPending,
    plan,
    preview,
  })
  const canApproveDeploy =
    Boolean(plan) &&
    cloudflareStatus.status === 'connected' &&
    Boolean(cloudflareStatus.accountId) &&
    hasWorkersWritePermission(cloudflareStatus.permissions)
  const canDeployWorker =
    canApproveDeploy &&
    Boolean(deployApproval) &&
    Boolean(generatedApp) &&
    checkResult?.status === 'passed' &&
    preview?.status === 'ready' &&
    !deployResult
  const canRunBuildDeployPipeline =
    canApproveDeploy && Boolean(deployApproval) && !deployResult
  const paidActionFundingReady =
    !hasPaidAction || stripeProjectsStatus.status === 'connected'

  return (
    <aside className="workbench" aria-label="Build preview">
      <div className="workbench-header">
        <div>
          <span>Preview</span>
          <strong>{plan?.deployment.workerName ?? 'New Worker app'}</strong>
        </div>
        <button
          type="button"
          disabled={!plan}
          onClick={() => setDeployApprovalRequested(true)}
        >
          <Globe2 size={16} />
          Deploy gated
        </button>
      </div>

      <div className="preview-frame">
        <div className="preview-toolbar">
          <span />
          <span />
          <span />
          <p>{plan?.deployment.domain ?? 'preview.ghostbuild.dev'}</p>
        </div>
        <div className="preview-content">
          <div className="preview-hero">
            <Rocket size={28} />
            <h2>{executionProgress.title}</h2>
            <p>{executionProgress.detail}</p>
          </div>
          <div className="preview-list">
            {executionProgress.stages.map((stage) => (
              <div key={stage.id}>
                <BuildStageIcon status={stage.status} />
                <span>
                  <b>{stage.title}</b>
                  {stage.detail}
                </span>
              </div>
            ))}
          </div>
          {plan && !generatedApp ? (
            <div className="build-action-row">
              <button
                type="button"
                className="generate-worker-button"
                disabled={isRunningPipeline || isPending}
                onClick={async () => {
                  setIsRunningPipeline(true)
                  try {
                    await onRunBuildPipeline()
                  } finally {
                    setIsRunningPipeline(false)
                  }
                }}
              >
                {isRunningPipeline ? (
                  <Loader2 className="animate-spin" size={15} />
                ) : (
                  <Rocket size={15} />
                )}
                Run build pipeline
              </button>
              <button
                type="button"
                className="generate-worker-button secondary"
                disabled={isGeneratingWorker || isPending}
                onClick={async () => {
                  setIsGeneratingWorker(true)
                  try {
                    await onGenerateWorkerApp()
                  } finally {
                    setIsGeneratingWorker(false)
                  }
                }}
              >
                {isGeneratingWorker ? (
                  <Loader2 className="animate-spin" size={15} />
                ) : (
                  <Rocket size={15} />
                )}
                Generate Worker files
              </button>
            </div>
          ) : null}
          {generatedApp ? (
            <div className="generated-files">
              <span>Generated files</span>
              {generatedApp.files.map((file) => (
                <code key={file.path}>{file.path}</code>
              ))}
            </div>
          ) : null}
          {generatedApp && !checkResult ? (
            <button
              type="button"
              className="generate-worker-button"
              disabled={isRunningChecks}
              onClick={async () => {
                setIsRunningChecks(true)
                try {
                  await onRunBuildChecks()
                } finally {
                  setIsRunningChecks(false)
                }
              }}
            >
              {isRunningChecks ? (
                <Loader2 className="animate-spin" size={15} />
              ) : (
                <CheckCircle2 size={15} />
              )}
              Run artifact checks
            </button>
          ) : null}
          {checkResult ? (
            <div className="generated-files">
              <span>Artifact checks {checkResult.status}</span>
              {checkResult.checks.map((check) => (
                <code key={check.name}>{check.name}: {check.status}</code>
              ))}
            </div>
          ) : null}
          {checkResult?.status === 'failed' ? (
            <div className="build-action-row">
              <button
                type="button"
                className="generate-worker-button"
                disabled={isRequestingAgentPatch}
                onClick={async () => {
                  setIsRequestingAgentPatch(true)
                  try {
                    await onRequestAgentPatch()
                  } finally {
                    setIsRequestingAgentPatch(false)
                  }
                }}
              >
                {isRequestingAgentPatch ? (
                  <Loader2 className="animate-spin" size={15} />
                ) : (
                  <Rocket size={15} />
                )}
                Ask agent to patch
              </button>
              <button
                type="button"
                className="generate-worker-button secondary"
                disabled={isRepairingWorker}
                onClick={async () => {
                  setIsRepairingWorker(true)
                  try {
                    await onRepairGeneratedApp()
                  } finally {
                    setIsRepairingWorker(false)
                  }
                }}
              >
                {isRepairingWorker ? (
                  <Loader2 className="animate-spin" size={15} />
                ) : (
                  <Rocket size={15} />
                )}
                Repair generated files
              </button>
            </div>
          ) : null}
          {checkResult?.status === 'passed' && !preview ? (
            <button
              type="button"
              className="generate-worker-button"
              disabled={isPreparingPreview}
              onClick={async () => {
                setIsPreparingPreview(true)
                try {
                  await onPrepareBuildPreview()
                } finally {
                  setIsPreparingPreview(false)
                }
              }}
            >
              {isPreparingPreview ? (
                <Loader2 className="animate-spin" size={15} />
              ) : (
                <Globe2 size={15} />
              )}
              Prepare preview
            </button>
          ) : null}
          {preview ? (
            <div className="generated-files">
              <span>Preview ready</span>
              <a href={preview.url}>{preview.url}</a>
              <a href={preview.healthUrl}>{preview.healthUrl}</a>
            </div>
          ) : null}
          {canDeployWorker ? (
            <button
              type="button"
              className="generate-worker-button"
              disabled={isDeployingWorker}
              onClick={async () => {
                setIsDeployingWorker(true)
                try {
                  await onDeployWorkerApp()
                } finally {
                  setIsDeployingWorker(false)
                }
              }}
            >
              {isDeployingWorker ? (
                <Loader2 className="animate-spin" size={15} />
              ) : (
                <Globe2 size={15} />
              )}
              Deploy Worker
            </button>
          ) : null}
          {deployResult ? (
            <div className="generated-files">
              <span>Deployed Worker</span>
              <a href={deployResult.dashboardUrl}>{deployResult.dashboardUrl}</a>
            </div>
          ) : null}
        </div>
      </div>

      <div className="deploy-card">
        <span>{plan ? `Goal ${plan.goal.status}` : 'Active goal'}</span>
        <strong>{plan?.goal.objective ?? 'No goal yet'}</strong>
        <ChecklistItems
          items={
            plan?.goal.successCriteria ?? [
              'Describe the web app you want GhostBuild to build.',
              'Connect ChatGPT/Codex before starting the run.',
            ]
          }
        />
      </div>

      <div className="deploy-card">
        <span>Cloudflare readiness</span>
        <ChecklistItems items={readinessItems} />
        {cloudflareStatus.status !== 'connected' ? (
          <div className="cloudflare-connect-form">
            <input
              type="password"
              value={cloudflareToken}
              placeholder="Cloudflare API token"
              onChange={(event) => setCloudflareToken(event.target.value)}
            />
            <button
              type="button"
              disabled={!cloudflareToken.trim() || isConnectingCloudflare}
              onClick={async () => {
                setIsConnectingCloudflare(true)
                setCloudflareConnectError('')
                try {
                  await onConnectCloudflareToken(cloudflareToken)
                  setCloudflareToken('')
                } catch (error) {
                  setCloudflareConnectError(
                    error instanceof Error
                      ? error.message
                      : 'Unable to connect Cloudflare.',
                  )
                } finally {
                  setIsConnectingCloudflare(false)
                }
              }}
            >
              Connect
            </button>
            {cloudflareConnectError ? <p>{cloudflareConnectError}</p> : null}
          </div>
        ) : null}
      </div>

      <div className="deploy-card">
        <span>Cloudflare API MCP</span>
        <strong>{describeCloudflareMcpTitle(cloudflareMcpStatus)}</strong>
        <p>{cloudflareMcpStatus.message}</p>
        {cloudflareMcpStatus.status === 'ready' ? (
          <div className="capability-row">
            <CheckCircle2 size={16} />
            <p>{cloudflareMcpStatus.toolsCount} Cloudflare tools available</p>
          </div>
        ) : null}
        {cloudflareMcpStatus.status === 'failed' && cloudflareMcpStatus.error ? (
          <p>{cloudflareMcpStatus.error}</p>
        ) : null}
        {cloudflareMcpError ? <p>{cloudflareMcpError}</p> : null}
        <button
          type="button"
          disabled={!plan || isConnectingCloudflareMcp}
          onClick={async () => {
            setIsConnectingCloudflareMcp(true)
            setCloudflareMcpError('')
            try {
              await onConnectCloudflareMcp()
            } catch (error) {
              setCloudflareMcpError(
                error instanceof Error
                  ? error.message
                  : 'Unable to connect Cloudflare API MCP.',
              )
            } finally {
              setIsConnectingCloudflareMcp(false)
            }
          }}
        >
          {isConnectingCloudflareMcp ? (
            <Loader2 className="animate-spin" size={15} />
          ) : (
            <CloudMcpIcon status={cloudflareMcpStatus.status} />
          )}
          {cloudflareMcpStatus.status === 'authenticating'
            ? 'Open authorization'
            : 'Connect MCP'}
        </button>
      </div>

      <div className="deploy-card">
        <span>Cloudflare stack</span>
        <div className="stack-readiness-strip">
          {cloudflareStackReadiness.map((item) => (
            <span key={item}>
              <CheckCircle2 size={14} />
              {item}
            </span>
          ))}
        </div>
      </div>

      {deployApprovalRequested ? (
        <div className="deploy-card approval-card">
          <span>{deployApproval ? 'Approval recorded' : 'Approval required'}</span>
          <strong>{plan?.deployment.workerName ?? 'Deploy Worker'}</strong>
          <p>
            {deployApproval
              ? `${deployApproval.id} confirms ${deployApproval.workerName} for ${deployApproval.accountName ?? deployApproval.accountId}.`
              : 'Deployment is blocked until the user confirms the target account, Worker name, bindings, and any paid infrastructure changes.'}
          </p>
          {plan ? (
            <div className="approval-details">
              <div>
                <b>Account</b>
                {cloudflareStatus.accountName ?? cloudflareStatus.accountId ?? 'Not connected'}
              </div>
              <div>
                <b>Worker</b>
                {plan.deployment.workerName}
              </div>
              <div>
                <b>Bindings</b>
                {plan.deployment.bindings.join(', ') || 'None'}
              </div>
              <label>
                <b>Estimated cost</b>
                <input
                  value={deployApproval?.estimatedCost ?? estimatedCost}
                  disabled={Boolean(deployApproval)}
                  onChange={(event) => setEstimatedCost(event.target.value)}
                />
              </label>
              <label className="approval-check">
                <input
                  type="checkbox"
                  checked={deployApproval?.hasPaidAction ?? hasPaidAction}
                  disabled={Boolean(deployApproval)}
                  onChange={(event) => setHasPaidAction(event.target.checked)}
                />
                Includes paid Cloudflare action
              </label>
              <label className="approval-check">
                <input
                  type="checkbox"
                  checked={
                    deployApproval?.hasDestructiveAction ?? hasDestructiveAction
                  }
                  disabled={Boolean(deployApproval)}
                  onChange={(event) =>
                    setHasDestructiveAction(event.target.checked)
                  }
                />
                Includes destructive Cloudflare action
              </label>
            </div>
          ) : null}
          <button
            type="button"
            disabled={!canApproveDeploy || isApprovingDeploy || Boolean(deployApproval)}
            onClick={async () => {
              setIsApprovingDeploy(true)
              try {
                if (!paidActionFundingReady) {
                  setStripeProjectsError(
                    'Connect your own Stripe Project before approving paid Cloudflare actions.',
                  )
                  return
                }

                await onRequestDeployApproval({
                  estimatedCost,
                  hasDestructiveAction,
                  hasPaidAction,
                })
              } finally {
                setIsApprovingDeploy(false)
              }
            }}
          >
            <LockKeyhole size={15} />
            {deployApproval ? 'Confirmed' : 'Confirm deploy'}
          </button>
          {canRunBuildDeployPipeline ? (
            <button
              type="button"
              disabled={isRunningDeployPipeline}
              onClick={async () => {
                setIsRunningDeployPipeline(true)
                try {
                  await onRunBuildDeployPipeline()
                } finally {
                  setIsRunningDeployPipeline(false)
                }
              }}
            >
              {isRunningDeployPipeline ? (
                <Loader2 className="animate-spin" size={15} />
              ) : (
                <Globe2 size={15} />
              )}
              Build and deploy
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="deploy-card">
        <span>Default capabilities</span>
        <ChecklistItems items={defaultCapabilities} />
      </div>

      <div className="deploy-card">
        <span>Zero-to-production run</span>
        <ChecklistItems items={productionSteps} />
      </div>

      <div className="deploy-card wallet-card">
        <span>Cloudflare-first ownership model</span>
        <strong>Your goal, your Cloudflare app</strong>
        <p>
          GhostBuild connects through ChatGPT/Codex OAuth for model access.
          Each user connects their own Stripe Project for funded Cloudflare
          actions. GhostBuild stores only connection metadata and approval state.
        </p>
        <div className="capability-row">
          <StripeProjectsIcon status={stripeProjectsStatus.status} />
          <p>
            <b>{describeStripeProjectsTitle(stripeProjectsStatus)}</b>
            {stripeProjectsStatus.message}
          </p>
        </div>
        {stripeProjectsStatus.status === 'connected' ? (
          <div className="capability-row">
            <CheckCircle2 size={16} />
            <p>
              <b>Stripe Project</b>
              {stripeProjectsStatus.stripeProjectId}
            </p>
          </div>
        ) : null}
        <div className="capability-row">
          <CheckCircle2 size={16} />
          <p>
            <b>Provider spend limit</b>
            Default ${stripeProjectsStatus.defaultProviderSpendLimitUsd}/month
            per provider; raise it from the user's Cloudflare account when
            needed.
          </p>
        </div>
        {stripeProjectsError ? <p>{stripeProjectsError}</p> : null}
        <button
          type="button"
          disabled={isConnectingStripeProjects}
          onClick={async () => {
            setIsConnectingStripeProjects(true)
            setStripeProjectsError('')
            try {
              await onConnectStripeProjects()
            } catch (error) {
              setStripeProjectsError(
                error instanceof Error
                  ? error.message
                  : 'Unable to connect Stripe Projects.',
              )
            } finally {
              setIsConnectingStripeProjects(false)
            }
          }}
        >
          {isConnectingStripeProjects ? (
            <Loader2 className="animate-spin" size={15} />
          ) : (
            <StripeProjectsIcon status={stripeProjectsStatus.status} />
          )}
          Connect Stripe Project
        </button>
        {ownershipLineItems.map(([label, detail]) => (
          <div className="capability-row" key={label}>
            <CheckCircle2 size={16} />
            <p>
              <b>{label}</b>
              {detail}
            </p>
          </div>
        ))}
      </div>
    </aside>
  )
}

const initialCloudflareMcpStatus: CloudflareMcpStatus = {
  status: 'not-started',
  message: 'Create a builder session before authorizing Cloudflare API MCP.',
  serverName: 'cloudflare-api',
  serverUrl: 'https://mcp.cloudflare.com/mcp',
  toolsCount: 0,
}

const initialStripeProjectsStatus: StripeProjectsConnectionStatus = {
  status: 'disconnected',
  message: 'Connect your own Stripe Project before paid Cloudflare actions.',
  defaultProviderSpendLimitUsd: 100,
}

function BuildStageIcon({ status }: { status: BuildExecutionStageStatus }) {
  if (status === 'running') {
    return <Loader2 className="animate-spin" size={16} />
  }

  if (status === 'completed' || status === 'ready') {
    return <CheckCircle2 size={16} />
  }

  return <Square size={14} />
}

function CloudMcpIcon({ status }: { status: CloudflareMcpStatus['status'] }) {
  return status === 'ready' ? <CheckCircle2 size={15} /> : <LockKeyhole size={15} />
}

function StripeProjectsIcon({
  status,
}: {
  status: StripeProjectsConnectionStatus['status']
}) {
  return status === 'connected' ? (
    <CheckCircle2 size={15} />
  ) : (
    <LockKeyhole size={15} />
  )
}

function ChecklistItems({ items }: { items: ReadonlyArray<string> }) {
  return items.map((item) => (
    <div className="capability-row" key={item}>
      <CheckCircle2 size={16} />
      <p>{item}</p>
    </div>
  ))
}

function buildReadinessItems(
  authState: CodexAuthState,
  hasPlan: boolean,
  cloudflareStatus: CloudflareConnectionStatus,
  deployApproval?: DeployApprovalRecord,
) {
  return [
    authState.status === 'connected'
      ? 'ChatGPT/Codex connected'
      : 'ChatGPT/Codex connection required',
    hasPlan ? 'Goal and Cloudflare plan drafted' : 'Goal not planned yet',
    describeCloudflareStatus(cloudflareStatus),
    cloudflareStatus.status === 'connected' &&
    hasWorkersWritePermission(cloudflareStatus.permissions)
      ? 'Workers write permission verified'
      : 'Workers write permission required before deploy',
    deployApproval
      ? `Deploy approval recorded for ${deployApproval.workerName}`
      : 'Deploy approval required before publishing',
  ]
}

function describeCloudflareStatus(status: CloudflareConnectionStatus) {
  if (status.status === 'connected') {
    return status.accountName
      ? `Cloudflare account connected: ${status.accountName}`
      : 'Cloudflare token verified'
  }

  return status.message
}

function describeCloudflareMcpTitle(status: CloudflareMcpStatus) {
  if (status.status === 'ready') {
    return 'Authorized'
  }

  if (status.status === 'authenticating') {
    return 'Authorization required'
  }

  if (status.status === 'failed') {
    return 'Connection failed'
  }

  return 'Optional for planning'
}

function describeStripeProjectsTitle(status: StripeProjectsConnectionStatus) {
  if (status.status === 'connected') {
    return 'User funding connected'
  }

  if (status.status === 'unconfigured') {
    return 'Stripe Projects URL missing'
  }

  if (status.status === 'connecting') {
    return 'Finish Stripe Projects authorization'
  }

  return 'User funding required'
}
