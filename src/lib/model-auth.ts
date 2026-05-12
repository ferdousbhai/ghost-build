export type AppAccountMetadata = {
  email?: string
  name?: string
  userId?: string
  image?: string | null
}

export type AppAuthState = {
  mode: 'better-auth'
  status: 'disconnected' | 'connected'
  account?: AppAccountMetadata
  recoveryUrl?: string
  message?: string
}

export type ModelRuntimeAuth = {
  mode: 'server-openai-api-key'
  apiKey: string
  billingSummary: string
}

export type ModelAuthResolutionInput = {
  openAiApiKey?: string
}

export function resolveModelRuntimeAuth(
  input: ModelAuthResolutionInput,
): ModelRuntimeAuth {
  if (!input.openAiApiKey) {
    throw new Error('Server-side OpenAI API key is required.')
  }

  return {
    mode: 'server-openai-api-key',
    apiKey: input.openAiApiKey,
    billingSummary: 'GhostBuild server-side OpenAI API billing.',
  }
}

export function summarizeAppAuthState(session?: {
  user?: {
    id?: string
    email?: string
    name?: string
    image?: string | null
  }
} | null): AppAuthState {
  if (!session?.user?.id) {
    return {
      mode: 'better-auth',
      status: 'disconnected',
      recoveryUrl: '/api/auth/sign-in/social',
      message: 'Sign in to GhostBuild before running the builder.',
    }
  }

  return {
    mode: 'better-auth',
    status: 'connected',
    account: {
      userId: session.user.id,
      email: session.user.email,
      name: session.user.name,
      image: session.user.image,
    },
  }
}
