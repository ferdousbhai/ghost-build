export type ChatGptAccountMetadata = {
  email?: string
  userId?: string
  accountId?: string
  planType?: string
  workspaceState?: 'unknown' | 'personal' | 'workspace' | 'fedramp'
  fedRamp?: boolean
}

export type CodexAuthState =
  {
    mode: 'chatgpt-codex-oauth'
    status:
      | 'disconnected'
      | 'connecting'
      | 'connected'
      | 'expired'
      | 'refresh-failed'
      | 'unsupported'
    account?: ChatGptAccountMetadata
    recoveryUrl?: string
    message?: string
  }

export type ModelRuntimeAuth = {
  mode: 'chatgpt-codex-oauth'
  accessToken: string
  account: ChatGptAccountMetadata
  billingSummary: string
}

export type ModelAuthResolutionInput = {
  codexAccessToken?: string
  codexAccount?: ChatGptAccountMetadata
}

export function resolveModelRuntimeAuth(
  input: ModelAuthResolutionInput,
): ModelRuntimeAuth {
  if (!input.codexAccessToken) {
    throw new Error('ChatGPT/Codex OAuth credentials are required.')
  }

  const account = input.codexAccount

  if (!hasUsableAccountMetadata(account)) {
    throw new Error('ChatGPT/Codex account metadata is missing or incomplete.')
  }

  return {
    mode: 'chatgpt-codex-oauth',
    accessToken: input.codexAccessToken,
    account,
    billingSummary:
      'ChatGPT/Codex OAuth using eligible Codex plan allowance when available.',
  }
}

export function summarizeCodexAuthState(options: {
  account?: ChatGptAccountMetadata
  hasToken?: boolean
} = {}): CodexAuthState {
  const { account, hasToken } = options

  if (!account) {
    return {
      mode: 'chatgpt-codex-oauth',
      status: 'disconnected',
      recoveryUrl: '/api/codex-auth/start',
      message: 'Connect ChatGPT/Codex before running in Codex mode.',
    }
  }

  if (!hasToken) {
    return {
      mode: 'chatgpt-codex-oauth',
      status: 'expired',
      account,
      recoveryUrl: '/api/codex-auth/start',
      message: 'ChatGPT/Codex credentials expired. Reconnect to continue.',
    }
  }

  if (!hasUsableAccountMetadata(account)) {
    return {
      mode: 'chatgpt-codex-oauth',
      status: 'unsupported',
      account,
      recoveryUrl: '/api/codex-auth/logout',
      message:
        'The connected ChatGPT/Codex account did not return enough metadata for billing-safe runs.',
    }
  }

  return {
    mode: 'chatgpt-codex-oauth',
    status: 'connected',
    account,
  }
}

export function hasUsableAccountMetadata(
  account?: ChatGptAccountMetadata,
): account is ChatGptAccountMetadata {
  return Boolean(account?.email && account.planType)
}
