import type { AppAuthState } from '#/lib/model-auth'

export const appAuthChangedEvent = 'ghostbuild:app-auth-changed'

const disconnectedAuth: AppAuthState = {
  mode: 'better-auth',
  status: 'disconnected',
  recoveryUrl: '/api/auth/sign-in/social',
  message: 'Sign in to GhostBuild before running the builder.',
}

export async function readAppAuthState() {
  try {
    const response = await fetch('/api/app-auth/status')

    if (!response.ok) {
      return disconnectedAuth
    }

    return (await response.json()) as AppAuthState
  } catch {
    return disconnectedAuth
  }
}

export function isAppAuthConnected(authState: AppAuthState) {
  return authState.status === 'connected'
}

export function notifyAppAuthChanged() {
  window.dispatchEvent(new Event(appAuthChangedEvent))
}
