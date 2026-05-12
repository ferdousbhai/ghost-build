import type { AgentPlan } from './agent'
import type { CloudflareConnectionStatus } from './cloudflare-status'
import { assertDeployActionAllowed, type DeployApprovalRecord } from './deploy-approval'
import { assertActionAllowed, type ApprovalConfirmation } from './permissions'

export type RuntimeActionRequest =
  | {
      type: 'deploy_worker'
      plan: AgentPlan
      cloudflareStatus: CloudflareConnectionStatus
      approval?: DeployApprovalRecord
    }
  | {
      type: 'paid_cloudflare_action'
      action: 'buy_domain' | 'fund_account' | 'enable_paid_service'
      resource: string
      confirmation?: ApprovalConfirmation
    }
  | {
      type: 'destructive_cloudflare_action'
      action: 'delete_worker' | 'delete_resource' | 'remove_dns_record'
      resource: string
      confirmation?: ApprovalConfirmation
    }

export type RuntimeActionResult = {
  status: 'allowed'
  action: string
  resource: string
  accountId?: string
}

export function assertRuntimeActionAllowed(
  request: RuntimeActionRequest,
): RuntimeActionResult {
  if (request.type === 'deploy_worker') {
    assertCloudflareConnected(request.cloudflareStatus)
    assertDeployActionAllowed(request.plan, request.approval)

    if (
      request.approval?.accountId &&
      request.cloudflareStatus.accountId &&
      request.approval.accountId !== request.cloudflareStatus.accountId
    ) {
      throw new Error('Deploy approval does not match the connected account.')
    }

    return {
      status: 'allowed',
      action: 'deploy_worker',
      resource: request.plan.deployment.workerName,
      accountId: request.cloudflareStatus.accountId,
    }
  }

  if (request.type === 'paid_cloudflare_action') {
    assertActionAllowed(
      'paid-cloudflare-action',
      request.action,
      request.confirmation,
    )

    return {
      status: 'allowed',
      action: request.action,
      resource: request.resource,
    }
  }

  assertActionAllowed(
    'destructive-cloudflare-action',
    request.action,
    request.confirmation,
  )

  return {
    status: 'allowed',
    action: request.action,
    resource: request.resource,
  }
}

function assertCloudflareConnected(status: CloudflareConnectionStatus) {
  if (status.status !== 'connected' || !status.accountId) {
    throw new Error('Cloudflare account connection is required.')
  }
}
