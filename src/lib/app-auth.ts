import { betterAuth } from 'better-auth'
import { memoryAdapter, type MemoryDB } from '@better-auth/memory-adapter'
import { tanstackStartCookies } from 'better-auth/tanstack-start'
import { env } from 'cloudflare:workers'
import { parseCookies } from './http-cookies'
import { summarizeAppAuthState } from './model-auth'

type AuthEnv = Cloudflare.Env & {
  AUTH_DB?: D1Database
  BETTER_AUTH_URL?: string
  BETTER_AUTH_SECRET?: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  GITHUB_CLIENT_ID?: string
  GITHUB_CLIENT_SECRET?: string
}

const testAuthDb: MemoryDB = {
  user: [],
  session: [],
  account: [],
  verification: [],
}

export const auth = betterAuth({
  appName: 'GhostBuild',
  baseURL: readAuthEnv().BETTER_AUTH_URL ?? 'https://ghostbuild.dev',
  database: readAuthDatabase(),
  secret: readAuthEnv().BETTER_AUTH_SECRET,
  socialProviders: readSocialProviders(),
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
  },
  trustedOrigins: [
    'https://ghostbuild.dev',
    'https://www.ghostbuild.dev',
    'http://localhost:3000',
  ],
  plugins: [tanstackStartCookies()],
})

export type AppSession = NonNullable<
  Awaited<ReturnType<typeof auth.api.getSession>>
>

export async function readAppSessionFromRequest(request: Request) {
  const testSession = readTestAppSession(request)

  if (testSession) {
    return testSession
  }

  return auth.api.getSession({ headers: request.headers })
}

export async function requireAppSession(request: Request) {
  const session = await readAppSessionFromRequest(request)

  if (!session) {
    return {
      session: undefined,
      response: Response.json(
        { error: 'GhostBuild sign-in is required.' },
        { status: 401 },
      ),
    }
  }

  return { session, response: undefined }
}

export async function createAppAuthStatus(request: Request) {
  return summarizeAppAuthState(await readAppSessionFromRequest(request))
}

export function ownerIdFromAppSession(session: AppSession) {
  return session.user.id
}

function readAuthDatabase() {
  if (process.env.NODE_ENV === 'test') {
    return memoryAdapter(testAuthDb)
  }

  return readAuthEnv().AUTH_DB ?? memoryAdapter(testAuthDb)
}

function readSocialProviders() {
  const authEnv = readAuthEnv()

  return {
    ...(authEnv.GOOGLE_CLIENT_ID && authEnv.GOOGLE_CLIENT_SECRET
      ? {
          google: {
            clientId: authEnv.GOOGLE_CLIENT_ID,
            clientSecret: authEnv.GOOGLE_CLIENT_SECRET,
          },
        }
      : {}),
    ...(authEnv.GITHUB_CLIENT_ID && authEnv.GITHUB_CLIENT_SECRET
      ? {
          github: {
            clientId: authEnv.GITHUB_CLIENT_ID,
            clientSecret: authEnv.GITHUB_CLIENT_SECRET,
          },
        }
      : {}),
  }
}

function readTestAppSession(request: Request) {
  if (process.env.NODE_ENV !== 'test') {
    return undefined
  }

  const email =
    request.headers.get('x-ghostbuild-test-user') ??
    parseCookies(request.headers.get('cookie') ?? '').ghostbuild_test_user

  if (!email) {
    return undefined
  }

  return {
    session: {
      id: 'session_test',
      token: 'test-token',
      userId: 'user_test',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    user: {
      id: 'user_test',
      email,
      emailVerified: true,
      name: email,
      image: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  } satisfies AppSession
}

function readAuthEnv() {
  return env as AuthEnv
}
