import type { AgentPlan } from './agent'
import {
  assertActionAllowed,
  type ApprovalConfirmation,
} from './permissions'

export type DeployApprovalRequest = {
  accountId: string
  accountName?: string
  workerName: string
  bindings: Array<string>
  estimatedCost?: string
  hasPaidAction: boolean
  hasDestructiveAction: boolean
  confirmedBy: string
}

export type DeployApprovalRecord = ApprovalConfirmation & {
  workerName: string
  bindings: Array<string>
  accountId: string
  accountName?: string
  hasPaidAction: boolean
  hasDestructiveAction: boolean
}

export function createDeployApprovalRecord(
  input: DeployApprovalRequest,
): DeployApprovalRecord {
  const confirmation = {
    id: `approval_${crypto.randomUUID()}`,
    presetId: 'deploy',
    action: 'deploy_worker',
    resource: input.workerName,
    risk: input.hasDestructiveAction || input.hasPaidAction ? 'high' : 'medium',
    estimatedCost: input.estimatedCost,
    confirmedAt: new Date().toISOString(),
    confirmedBy: input.confirmedBy,
  } satisfies ApprovalConfirmation

  assertActionAllowed('deploy', 'deploy_worker', confirmation)

  if (input.hasPaidAction) {
    assertActionAllowed('paid-cloudflare-action', 'enable_paid_service', {
      ...confirmation,
      presetId: 'paid-cloudflare-action',
      action: 'enable_paid_service',
    })
  }

  if (input.hasDestructiveAction) {
    assertActionAllowed('destructive-cloudflare-action', 'delete_resource', {
      ...confirmation,
      presetId: 'destructive-cloudflare-action',
      action: 'delete_resource',
    })
  }

  return {
    ...confirmation,
    accountId: input.accountId,
    accountName: input.accountName,
    bindings: input.bindings,
    workerName: input.workerName,
    hasPaidAction: input.hasPaidAction,
    hasDestructiveAction: input.hasDestructiveAction,
  }
}

export function assertDeployActionAllowed(
  plan: AgentPlan,
  approval?: DeployApprovalRecord,
) {
  assertActionAllowed('deploy', 'deploy_worker', approval)

  if (!approval || approval.workerName !== plan.deployment.workerName) {
    throw new Error('Deploy approval does not match this Worker.')
  }
}
