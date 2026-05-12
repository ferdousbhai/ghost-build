import type { CodexAuthState } from '#/lib/model-auth'

export const codexAuthChangedEvent = 'ghostbuild:codex-auth-changed'

const disconnectedCodexAuth: CodexAuthState = {
  mode: 'chatgpt-codex-oauth',
  status: 'disconnected',
  recoveryUrl: '/api/codex-auth/start',
  message: 'Connect ChatGPT/Codex before running in Codex mode.',
}

export async function readCodexAuthState() {
  try {
    const response = await fetch('/api/codex-auth/status')

    if (!response.ok) {
      return disconnectedCodexAuth
    }

    return (await response.json()) as CodexAuthState
  } catch {
    return disconnectedCodexAuth
  }
}

export function isCodexAuthConnected(authState: CodexAuthState) {
  return authState.status === 'connected'
}

export function notifyCodexAuthChanged() {
  window.dispatchEvent(new Event(codexAuthChangedEvent))
}
