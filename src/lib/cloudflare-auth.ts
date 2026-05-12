import { verifyCloudflareConnection } from './cloudflare-status'
import { parseCookies } from './http-cookies'

export const cloudflareTokenCookie = 'ghostbuild_cloudflare_token'

export async function connectCloudflareToken(
  request: Request,
  cookieSecret = readCloudflareCookieSecret(),
  fetcher: typeof fetch = fetch,
) {
  const payload = (await request.json().catch(() => ({}))) as {
    token?: string
  }
  const token = payload.token?.trim()

  if (!token) {
    return Response.json({ error: 'Cloudflare API token is required.' }, {
      status: 400,
    })
  }

  const status = await verifyCloudflareConnection(token, fetcher)

  if (status.status !== 'connected') {
    return Response.json({ status }, { status: 400 })
  }

  return Response.json(
    { status },
    {
      headers: {
        'set-cookie': serializeCloudflareCookie(
          await sealCloudflareTokenCookieValue({ token }, cookieSecret),
        ),
      },
    },
  )
}

export async function disconnectCloudflareToken() {
  return Response.json(
    {
      status: {
        status: 'missing-token',
        permissions: [],
        message: 'Cloudflare account disconnected.',
      },
    },
    {
      headers: {
        'set-cookie': expireCloudflareCookie(),
      },
    },
  )
}

export async function readCloudflareTokenFromRequest(request: Request) {
  const cookies = parseCookies(request.headers.get('cookie') ?? '')
  const rawToken = cookies[cloudflareTokenCookie]

  if (!rawToken) {
    return undefined
  }

  try {
    const value = (await unsealCloudflareTokenCookieValue(rawToken)) as {
      token?: string
    }

    return value.token
  } catch {
    return undefined
  }
}

export async function verifyCloudflareConnectionFromRequest(
  request: Request,
  fetcher: typeof fetch = fetch,
) {
  return verifyCloudflareConnection(
    await readCloudflareTokenFromRequest(request),
    fetcher,
  )
}

export async function sealCloudflareTokenCookieValue(
  value: { token: string },
  secret = readCloudflareCookieSecret(),
) {
  if (!secret) {
    throw new Error(
      'CLOUDFLARE_TOKEN_COOKIE_SECRET or BETTER_AUTH_SECRET is required.',
    )
  }

  const iv = new Uint8Array(12)
  crypto.getRandomValues(iv)
  const key = await cloudflareCookieCryptoKey(secret)
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

async function unsealCloudflareTokenCookieValue(
  value: string,
  secret = readCloudflareCookieSecret(),
) {
  if (!secret) {
    throw new Error(
      'CLOUDFLARE_TOKEN_COOKIE_SECRET or BETTER_AUTH_SECRET is required.',
    )
  }

  const sealed = base64UrlDecode(value)
  const iv = sealed.slice(0, 12)
  const encrypted = sealed.slice(12)
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    await cloudflareCookieCryptoKey(secret),
    encrypted,
  )

  return JSON.parse(new TextDecoder().decode(decrypted)) as unknown
}

function serializeCloudflareCookie(value: string) {
  return `${cloudflareTokenCookie}=${value}; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax`
}

function expireCloudflareCookie() {
  return `${cloudflareTokenCookie}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`
}

function readCloudflareCookieSecret() {
  const env = process.env as Record<string, string | undefined>

  return env.CLOUDFLARE_TOKEN_COOKIE_SECRET ?? env.BETTER_AUTH_SECRET
}

async function cloudflareCookieCryptoKey(secret: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(secret),
  )

  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ])
}

function base64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function base64UrlDecode(value: string) {
  const padded = value.padEnd(value.length + ((4 - (value.length % 4)) % 4), '=')
  const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}
