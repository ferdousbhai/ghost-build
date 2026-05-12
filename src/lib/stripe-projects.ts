import { parseCookies } from './codex-oauth'

export const stripeProjectsConnectionCookie =
  'ghostbuild_stripe_projects_connection'
export const stripeProjectsStateCookie = 'ghostbuild_stripe_projects_state'

export type StripeProjectsConnectionStatus =
  | {
      status: 'disconnected'
      message: string
      defaultProviderSpendLimitUsd: number
    }
  | {
      status: 'unconfigured'
      message: string
      defaultProviderSpendLimitUsd: number
    }
  | {
      status: 'connecting'
      message: string
      connectUrl: string
      defaultProviderSpendLimitUsd: number
    }
  | {
      status: 'connected'
      message: string
      stripeProjectId: string
      cloudflareAccountId?: string
      connectedAt: string
      defaultProviderSpendLimitUsd: number
    }

export type StripeProjectsConnection = Extract<
  StripeProjectsConnectionStatus,
  { status: 'connected' }
>

export type StripeProjectsConfig = {
  connectUrl?: string
  cookieSecret?: string
}

const defaultProviderSpendLimitUsd = 100

export async function createStripeProjectsStatus(request: Request) {
  const connection = await readStripeProjectsConnectionFromRequest(request)

  return (
    connection ?? {
      status: 'disconnected',
      message: 'Connect your own Stripe Project before paid Cloudflare actions.',
      defaultProviderSpendLimitUsd,
    }
  )
}

export async function createStripeProjectsConnectResponse(
  request: Request,
  config = buildStripeProjectsConfig(),
) {
  if (!config.connectUrl) {
    return Response.json(
      {
        status: 'unconfigured',
        message:
          'Stripe Projects hosted connection URL is not configured for this deployment.',
        defaultProviderSpendLimitUsd,
      } satisfies StripeProjectsConnectionStatus,
      { status: 501 },
    )
  }

  const state = crypto.randomUUID()
  const connectUrl = new URL(config.connectUrl)
  const origin = new URL(request.url).origin

  connectUrl.searchParams.set(
    'return_url',
    `${origin}/api/stripe-projects/callback`,
  )
  connectUrl.searchParams.set('state', state)
  connectUrl.searchParams.set('provider', 'cloudflare')

  return Response.json(
    {
      status: 'connecting',
      message:
        'Continue to Stripe Projects to authorize Cloudflare provisioning and payment tokens.',
      connectUrl: connectUrl.toString(),
      defaultProviderSpendLimitUsd,
    } satisfies StripeProjectsConnectionStatus,
    {
      headers: {
        'set-cookie': serializeCookie(
          stripeProjectsStateCookie,
          await signCookieValue({ state }, config.cookieSecret),
          600,
        ),
      },
    },
  )
}

export async function createStripeProjectsCallbackResponse(
  request: Request,
  config = buildStripeProjectsConfig(),
) {
  const url = new URL(request.url)
  const expected = await readSignedCookie<{ state?: string }>(
    request,
    stripeProjectsStateCookie,
    config.cookieSecret,
  )
  const state = url.searchParams.get('state')
  const stripeProjectId = readFirstSearchParam(url, [
    'project_id',
    'stripe_project_id',
  ])
  const cloudflareAccountId = readFirstSearchParam(url, [
    'cloudflare_account_id',
    'account_id',
  ])

  if (!state || !expected?.state || state !== expected.state || !stripeProjectId) {
    return Response.json(
      { error: 'Stripe Projects connection validation failed.' },
      { status: 400 },
    )
  }

  const connection: StripeProjectsConnection = {
    status: 'connected',
    message: 'Stripe Project connected for user-funded Cloudflare actions.',
    stripeProjectId,
    cloudflareAccountId: cloudflareAccountId || undefined,
    connectedAt: new Date().toISOString(),
    defaultProviderSpendLimitUsd,
  }

  return new Response(null, {
    status: 302,
    headers: [
      ['location', '/?stripeProjects=connected'],
      [
        'set-cookie',
        serializeCookie(
          stripeProjectsConnectionCookie,
          await signCookieValue(connection, config.cookieSecret),
          60 * 60 * 24 * 30,
        ),
      ],
      ['set-cookie', expireCookie(stripeProjectsStateCookie)],
    ],
  })
}

export function disconnectStripeProjects() {
  return Response.json(
    {
      status: {
        status: 'disconnected',
        message: 'Stripe Project disconnected.',
        defaultProviderSpendLimitUsd,
      } satisfies StripeProjectsConnectionStatus,
    },
    {
      headers: {
        'set-cookie': expireCookie(stripeProjectsConnectionCookie),
      },
    },
  )
}

export async function readStripeProjectsConnectionFromRequest(request: Request) {
  return readSignedCookie<StripeProjectsConnection>(
    request,
    stripeProjectsConnectionCookie,
  )
}

export async function assertStripeProjectsFundingReady(
  request: Request,
  hasPaidAction: boolean,
) {
  if (!hasPaidAction) {
    return
  }

  const connection = await readStripeProjectsConnectionFromRequest(request)

  if (connection?.status !== 'connected') {
    throw new Error(
      'Connect your own Stripe Project before approving paid Cloudflare actions.',
    )
  }
}

export async function signStripeProjectsConnectionForTest(
  connection: StripeProjectsConnection,
  secret = readStripeProjectsCookieSecret(),
) {
  return signCookieValue(connection, secret)
}

export async function signStripeProjectsStateForTest(
  state: string,
  secret = readStripeProjectsCookieSecret(),
) {
  return signCookieValue({ state }, secret)
}

function buildStripeProjectsConfig(): StripeProjectsConfig {
  const env = process.env as Record<string, string | undefined>

  return {
    connectUrl: env.STRIPE_PROJECTS_CONNECT_URL,
    cookieSecret:
      env.STRIPE_PROJECTS_COOKIE_SECRET ??
      env.CODEX_OAUTH_COOKIE_SECRET ??
      env.BETTER_AUTH_SECRET,
  }
}

async function readSignedCookie<T>(
  request: Request,
  name: string,
  secret = readStripeProjectsCookieSecret(),
) {
  const rawValue = parseCookies(request.headers.get('cookie') ?? '')[name]

  if (!rawValue) {
    return undefined
  }

  try {
    return (await verifyCookieValue(rawValue, secret)) as T
  } catch {
    return undefined
  }
}

async function signCookieValue(
  value: unknown,
  secret = readStripeProjectsCookieSecret(),
) {
  if (!secret) {
    throw new Error(
      'STRIPE_PROJECTS_COOKIE_SECRET, CODEX_OAUTH_COOKIE_SECRET, or BETTER_AUTH_SECRET is required.',
    )
  }

  const body = base64Url(new TextEncoder().encode(JSON.stringify(value)))
  const signature = await hmac(body, secret)

  return `${body}.${signature}`
}

async function verifyCookieValue(
  value: string,
  secret = readStripeProjectsCookieSecret(),
) {
  if (!secret) {
    throw new Error(
      'STRIPE_PROJECTS_COOKIE_SECRET, CODEX_OAUTH_COOKIE_SECRET, or BETTER_AUTH_SECRET is required.',
    )
  }

  const [body, signature] = value.split('.')

  if (!body || !signature || (await hmac(body, secret)) !== signature) {
    throw new Error('Invalid Stripe Projects cookie signature.')
  }

  return JSON.parse(new TextDecoder().decode(base64UrlDecode(body))) as unknown
}

async function hmac(value: string, secret: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(value),
  )

  return base64Url(new Uint8Array(signature))
}

function serializeCookie(name: string, value: string, maxAge: number) {
  return `${name}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`
}

function expireCookie(name: string) {
  return `${name}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`
}

function readStripeProjectsCookieSecret() {
  const env = process.env as Record<string, string | undefined>

  return (
    env.STRIPE_PROJECTS_COOKIE_SECRET ??
    env.CODEX_OAUTH_COOKIE_SECRET ??
    env.BETTER_AUTH_SECRET
  )
}

function readFirstSearchParam(url: URL, names: ReadonlyArray<string>) {
  for (const name of names) {
    const value = url.searchParams.get(name)

    if (value) {
      return value
    }
  }

  return null
}

function base64Url(value: Uint8Array) {
  return btoa(String.fromCharCode(...value))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function base64UrlDecode(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    '=',
  )

  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))
}
