import type { AgentPlan } from './agent'
import type { BuildCheckResult } from './build-checks'
import type { BuildPreviewResult } from './build-preview'
import {
  hasWorkersWritePermission,
  type CloudflareConnectionStatus,
} from './cloudflare-status'
import type { DeployApprovalRecord } from './deploy-approval'
import type { GeneratedWorkerApp } from './generated-worker-app'
import { assertRuntimeActionAllowed } from './runtime-action-executor'

export type CloudflareDeployResult = {
  status: 'deployed'
  workerName: string
  accountId: string
  scriptId?: string
  dashboardUrl: string
  deployedAt: string
}

type CloudflareWorkerUploadResponse = {
  success?: boolean
  result?: {
    id?: string
  }
  errors?: Array<{
    message?: string
  }>
}

export async function deployGeneratedWorkerApp({
  approval,
  checkResult,
  cloudflareStatus,
  generatedApp,
  plan,
  preview,
  token,
  fetcher = fetch,
}: {
  approval?: DeployApprovalRecord
  checkResult?: BuildCheckResult
  cloudflareStatus: CloudflareConnectionStatus
  generatedApp?: GeneratedWorkerApp
  plan: AgentPlan
  preview?: BuildPreviewResult
  token?: string
  fetcher?: typeof fetch
}): Promise<CloudflareDeployResult> {
  if (!token) {
    throw new Error('Cloudflare token is required to deploy.')
  }

  if (!generatedApp) {
    throw new Error('Generated Worker app is required to deploy.')
  }

  if (generatedApp.workerName !== plan.deployment.workerName) {
    throw new Error('Generated Worker app does not match the active plan.')
  }

  if (checkResult?.status !== 'passed') {
    throw new Error('Passing artifact checks are required to deploy.')
  }

  if (preview?.status !== 'ready') {
    throw new Error('Preview readiness is required before deploy.')
  }

  const action = assertRuntimeActionAllowed({
    type: 'deploy_worker',
    plan,
    approval,
    cloudflareStatus,
  })

  if (!action.accountId) {
    throw new Error('Cloudflare account id is required to deploy.')
  }

  if (!hasWorkersWritePermission(cloudflareStatus.permissions)) {
    throw new Error('Cloudflare token requires Workers write permission.')
  }

  const response = await fetcher(
    `https://api.cloudflare.com/client/v4/accounts/${action.accountId}/workers/scripts/${encodeURIComponent(plan.deployment.workerName)}`,
    {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
      },
      body: createWorkerUploadForm(generatedApp),
    },
  )
  const data = (await response.json().catch(() => ({}))) as
    CloudflareWorkerUploadResponse

  if (!response.ok || !data.success) {
    throw new Error(
      data.errors?.[0]?.message || 'Cloudflare Worker upload failed.',
    )
  }

  return {
    status: 'deployed',
    workerName: plan.deployment.workerName,
    accountId: action.accountId,
    scriptId: data.result?.id,
    dashboardUrl: `https://dash.cloudflare.com/${action.accountId}/workers/services/view/${plan.deployment.workerName}/production`,
    deployedAt: new Date().toISOString(),
  }
}

function createWorkerUploadForm(generatedApp: GeneratedWorkerApp) {
  const workerModule = generatedApp.files.find((file) => file.path === 'worker.js')

  if (!workerModule?.content.trim()) {
    throw new Error('Generated Worker app is missing worker.js.')
  }

  const form = new FormData()
  const metadata = {
    main_module: 'worker.js',
    compatibility_date: '2026-05-12',
    bindings: [],
  }

  form.append(
    'metadata',
    new Blob([JSON.stringify(metadata)], { type: 'application/json' }),
  )
  form.append(
    'worker.js',
    new Blob([workerModule.content], {
      type: 'application/javascript+module',
    }),
    'worker.js',
  )

  return form
}
