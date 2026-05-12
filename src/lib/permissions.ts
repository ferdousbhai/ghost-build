export type PermissionPresetId =
  | 'planning'
  | 'code-changes'
  | 'preview'
  | 'deploy'
  | 'paid-cloudflare-action'
  | 'destructive-cloudflare-action'
  | 'github-writes'

export type PermissionPreset = {
  id: PermissionPresetId
  label: string
  requiresConfirmation: boolean
  allowedActions: Array<string>
}

export type ApprovalConfirmation = {
  id: string
  presetId: PermissionPresetId
  action: string
  resource: string
  risk: 'low' | 'medium' | 'high'
  estimatedCost?: string
  confirmedAt: string
  confirmedBy: string
}

export const permissionPresets = [
  {
    id: 'planning',
    label: 'Planning',
    requiresConfirmation: false,
    allowedActions: ['read_project', 'draft_plan', 'inspect_cloudflare_docs'],
  },
  {
    id: 'code-changes',
    label: 'Code Changes',
    requiresConfirmation: false,
    allowedActions: ['write_workspace', 'run_tests'],
  },
  {
    id: 'preview',
    label: 'Preview',
    requiresConfirmation: false,
    allowedActions: ['start_preview', 'read_preview_logs'],
  },
  {
    id: 'deploy',
    label: 'Deploy',
    requiresConfirmation: true,
    allowedActions: ['deploy_worker', 'bind_resources'],
  },
  {
    id: 'paid-cloudflare-action',
    label: 'Paid Cloudflare Action',
    requiresConfirmation: true,
    allowedActions: [
      'create_account',
      'buy_domain',
      'fund_account',
      'enable_paid_service',
      'change_billing_limit',
    ],
  },
  {
    id: 'destructive-cloudflare-action',
    label: 'Destructive Cloudflare Action',
    requiresConfirmation: true,
    allowedActions: [
      'delete_worker',
      'delete_resource',
      'remove_dns_record',
      'mutate_dns_record',
      'overwrite_deploy',
    ],
  },
  {
    id: 'github-writes',
    label: 'GitHub Writes',
    requiresConfirmation: true,
    allowedActions: ['push_branch', 'open_pull_request', 'merge_pull_request'],
  },
] as const satisfies Array<PermissionPreset>

export function findPermissionPreset(id: PermissionPresetId) {
  return permissionPresets.find((preset) => preset.id === id)
}

export function assertActionAllowed(
  presetId: PermissionPresetId,
  action: string,
  confirmation?: ApprovalConfirmation,
) {
  const preset = findPermissionPreset(presetId)

  if (!preset) {
    throw new Error(`Unknown permission preset: ${presetId}`)
  }

  if (!(preset.allowedActions as ReadonlyArray<string>).includes(action)) {
    throw new Error(`${action} is not allowed by ${preset.label}.`)
  }

  if (!preset.requiresConfirmation) {
    return
  }

  if (
    !confirmation ||
    confirmation.presetId !== presetId ||
    confirmation.action !== action
  ) {
    throw new Error(`${preset.label} requires explicit confirmation.`)
  }
}
