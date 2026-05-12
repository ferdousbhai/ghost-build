import type { ChatGptAccountMetadata } from './model-auth'

export type CodexOAuthConfig = {
  clientId?: string
  clientSecret?: string
  authorizeUrl?: string
  tokenUrl?: string
  revokeUrl?: string
  redirectUri: string
  cookieSecret?: string
}

export type CodexTokenResponse = {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  id_token?: string
  account?: Record<string, unknown>
  user?: Record<string, unknown>
  plan?: string
}

export const codexOAuthStateCookie = 'ghostbuild_codex_oauth_state'
export const codexOAuthVerifierCookie = 'ghostbuild_codex_pkce_verifier'
export const codexOAuthAccountCookie = 'ghostbuild_codex_account'
export const codexOAuthTokenCookie = 'ghostbuild_codex_token'

export async function createOAuthStart(config: CodexOAuthConfig) {
  if (!config.clientId || !config.authorizeUrl) {
    return Response.json(
      {
        error:
          'ChatGPT/Codex OAuth is not configured for this GhostBuild deployment.',
      },
      { status: 501 },
    )
  }

  const state = createVerifier()
  const verifier = createVerifier()
  const challenge = await createPkceChallenge(verifier)
  const url = new URL(config.authorizeUrl)

  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('redirect_uri', config.redirectUri)
  url.searchParams.set('scope', 'openid profile email')
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')

  return new Response(null, {
    status: 302,
    headers: redirectWithCookies(url.toString(), [
      serializeCookie(codexOAuthStateCookie, state, 600),
      serializeCookie(codexOAuthVerifierCookie, verifier, 600),
    ]),
  })
}

export async function exchangeOAuthCallback(
  request: Request,
  config: CodexOAuthConfig,
) {
  if (!config.clientId || !config.tokenUrl) {
    return Response.json({ error: 'ChatGPT/Codex OAuth is not configured.' }, {
      status: 501,
    })
  }

  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const cookies = parseCookies(request.headers.get('cookie') ?? '')
  const expectedState = cookies[codexOAuthStateCookie]
  const verifier = cookies[codexOAuthVerifierCookie]

  if (!isValidOAuthCallback({ code, state, expectedState, verifier })) {
    return Response.json(
      { error: 'ChatGPT/Codex OAuth state validation failed.' },
      { status: 400 },
    )
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.clientId,
    code: code ?? '',
    redirect_uri: config.redirectUri,
    code_verifier: verifier ?? '',
  })

  if (config.clientSecret) {
    body.set('client_secret', config.clientSecret)
  }

  const tokenResponse = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  })

  if (!tokenResponse.ok) {
    return Response.json(
      { error: 'ChatGPT/Codex OAuth token exchange failed.' },
      { status: 502 },
    )
  }

  const token = (await tokenResponse.json()) as CodexTokenResponse

  if (!token.access_token) {
    return Response.json(
      { error: 'ChatGPT/Codex OAuth did not return an access token.' },
      { status: 502 },
    )
  }

  const account = parseCodexAccountMetadata(token)
  const expiresIn = Math.max(60, token.expires_in ?? 3600)
  const sessionMaxAge = codexSessionMaxAge(token, expiresIn)

  return new Response(null, {
    status: 302,
    headers: redirectWithCookies('/', [
      expireCookie(codexOAuthStateCookie),
      expireCookie(codexOAuthVerifierCookie),
      serializeCookie(
        codexOAuthAccountCookie,
        encodeURIComponent(JSON.stringify(account)),
        sessionMaxAge,
      ),
      serializeCookie(
        codexOAuthTokenCookie,
        await sealCodexTokenCookieValue(
          {
            accessToken: token.access_token,
            refreshToken: token.refresh_token,
            expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
          },
          config.cookieSecret,
        ),
        sessionMaxAge,
      ),
    ]),
  })
}

export function readCodexAccountFromRequest(request: Request) {
  const cookies = parseCookies(request.headers.get('cookie') ?? '')
  const rawAccount = cookies[codexOAuthAccountCookie]

  if (!rawAccount) {
    return undefined
  }

  try {
    return JSON.parse(decodeURIComponent(rawAccount)) as ChatGptAccountMetadata
  } catch {
    return undefined
  }
}

export async function readCodexTokenFromRequest(request: Request) {
  const token = await readCodexTokenCookieFromRequest(request)

  return token?.accessToken && !isExpired(token.expiresAt)
    ? token.accessToken
    : undefined
}

export async function refreshCodexTokenFromRequest(
  request: Request,
  config: CodexOAuthConfig,
  fetcher: typeof fetch = fetch,
) {
  const token = await readCodexTokenCookieFromRequest(request)

  if (!token?.accessToken) {
    return { accessToken: undefined, refreshed: false }
  }

  if (!isExpired(token.expiresAt)) {
    return { accessToken: token.accessToken, refreshed: false }
  }

  if (!token.refreshToken || !config.clientId || !config.tokenUrl) {
    return { accessToken: undefined, refreshed: false }
  }

  const response = await fetcher(config.tokenUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: config.clientId,
      refresh_token: token.refreshToken,
      ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
    }),
  })

  if (!response.ok) {
    return { accessToken: undefined, refreshed: false }
  }

  const refreshedToken = (await response.json()) as CodexTokenResponse

  if (!refreshedToken.access_token) {
    return { accessToken: undefined, refreshed: false }
  }

  const expiresIn = Math.max(60, refreshedToken.expires_in ?? 3600)
  const refreshToken = refreshedToken.refresh_token ?? token.refreshToken

  return {
    accessToken: refreshedToken.access_token,
    refreshed: true,
    setCookie: serializeCookie(
      codexOAuthTokenCookie,
      await sealCodexTokenCookieValue(
        {
          accessToken: refreshedToken.access_token,
          refreshToken,
          expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
        },
        config.cookieSecret,
      ),
      codexSessionMaxAge({ refresh_token: refreshToken }, expiresIn),
    ),
  }
}

export async function createCodexLogout(request: Request, config: CodexOAuthConfig) {
  const token = await readCodexTokenFromRequest(request)

  if (token && config.revokeUrl) {
    await fetch(config.revokeUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        token,
        ...(config.clientId ? { client_id: config.clientId } : {}),
        ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
      }),
    }).catch(() => undefined)
  }

  return new Response(null, {
    status: 302,
    headers: redirectWithCookies('/', [
      expireCookie(codexOAuthStateCookie),
      expireCookie(codexOAuthVerifierCookie),
      expireCookie(codexOAuthAccountCookie),
      expireCookie(codexOAuthTokenCookie),
    ]),
  })
}

export function parseCodexAccountMetadata(
  token: CodexTokenResponse,
): ChatGptAccountMetadata {
  const account = token.account ?? {}
  const user = token.user ?? {}

  return {
    email: stringFrom(user.email) ?? stringFrom(account.email),
    userId: stringFrom(user.id) ?? stringFrom(account.user_id),
    accountId: stringFrom(account.id) ?? stringFrom(account.account_id),
    planType:
      stringFrom(token.plan) ??
      stringFrom(account.plan) ??
      stringFrom(account.plan_type),
    workspaceState: account.fedramp
      ? 'fedramp'
      : account.workspace
        ? 'workspace'
        : 'unknown',
    fedRamp: Boolean(account.fedramp),
  }
}

export async function sealCodexTokenCookieValue(
  value: {
    accessToken?: string
    refreshToken?: string
    expiresAt?: string
  },
  secret?: string,
) {
  return sealCookieValue(value, secret)
}

async function readCodexTokenCookieFromRequest(request: Request) {
  const cookies = parseCookies(request.headers.get('cookie') ?? '')
  const rawToken = cookies[codexOAuthTokenCookie]

  if (!rawToken) {
    return undefined
  }

  try {
    return (await unsealCookieValue(rawToken)) as {
      accessToken?: string
      refreshToken?: string
      expiresAt?: string
    }
  } catch {
    return undefined
  }
}

export function parseCookies(header: string) {
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name, ...value] = part.split('=')
        return [name, value.join('=')]
      }),
  )
}

export function buildCodexOAuthConfig(request: Request): CodexOAuthConfig {
  const url = new URL(request.url)
  const env = process.env as Record<string, string | undefined>

  return {
    clientId: env.CODEX_OAUTH_CLIENT_ID,
    clientSecret: env.CODEX_OAUTH_CLIENT_SECRET,
    authorizeUrl: env.CODEX_OAUTH_AUTHORIZE_URL,
    tokenUrl: env.CODEX_OAUTH_TOKEN_URL,
    revokeUrl: env.CODEX_OAUTH_REVOKE_URL,
    redirectUri: `${url.origin}/api/codex-auth/callback`,
    cookieSecret: env.CODEX_OAUTH_COOKIE_SECRET ?? env.BETTER_AUTH_SECRET,
  }
}

function serializeCookie(name: string, value: string, maxAge: number) {
  return `${name}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`
}

function codexSessionMaxAge(token: CodexTokenResponse, expiresIn: number) {
  return token.refresh_token ? 60 * 60 * 24 * 30 : expiresIn
}

function expireCookie(name: string) {
  return `${name}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`
}

function redirectWithCookies(location: string, cookies: Array<string>): HeadersInit {
  return [
    ['location', location],
    ...cookies.map((cookie) => ['set-cookie', cookie] as [string, string]),
  ]
}

function isValidOAuthCallback({
  code,
  expectedState,
  state,
  verifier,
}: {
  code: string | null
  expectedState?: string
  state: string | null
  verifier?: string
}) {
  return Boolean(
    code && state && expectedState && state === expectedState && verifier,
  )
}

function createVerifier() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return base64Url(bytes)
}

async function createPkceChallenge(verifier: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  )

  return base64Url(new Uint8Array(digest))
}

function base64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

async function sealCookieValue(value: unknown, secret = '') {
  if (!secret) {
    throw new Error('CODEX_OAUTH_COOKIE_SECRET or BETTER_AUTH_SECRET is required.')
  }

  const iv = new Uint8Array(12)
  crypto.getRandomValues(iv)
  const key = await cookieCryptoKey(secret)
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(JSON.stringify(value)),
  )
  const sealed = new Uint8Array(iv.byteLength + encrypted.byteLength)

  sealed.set(iv)
  sealed.set(new Uint8Array(encrypted), iv.byteLength)

  return base64Url(sealed)
}

async function unsealCookieValue(
  value: string,
  secret = (process.env as Record<string, string | undefined>)
    .CODEX_OAUTH_COOKIE_SECRET ??
    (process.env as Record<string, string | undefined>).BETTER_AUTH_SECRET,
) {
  if (!secret) {
    throw new Error('CODEX_OAUTH_COOKIE_SECRET or BETTER_AUTH_SECRET is required.')
  }

  const sealed = base64UrlDecode(value)
  const iv = sealed.slice(0, 12)
  const encrypted = sealed.slice(12)
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    await cookieCryptoKey(secret),
    encrypted,
  )

  return JSON.parse(new TextDecoder().decode(decrypted)) as unknown
}

async function cookieCryptoKey(secret: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(secret),
  )

  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ])
}

function base64UrlDecode(value: string) {
  const padded = value.padEnd(value.length + ((4 - (value.length % 4)) % 4), '=')
  const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

function stringFrom(value: unknown) {
  return typeof value === 'string' && value ? value : undefined
}

function isExpired(expiresAt?: string) {
  return Boolean(expiresAt && new Date(expiresAt).getTime() <= Date.now())
}
