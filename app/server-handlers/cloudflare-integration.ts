import { z } from 'zod';
import { createAuthSession, getAuthSession, upsertCloudflareUser } from '~/lib/.server/auth';
import {
  activateCloudflareConnection,
  findCloudflareConnectionForUser,
} from '~/lib/.server/cloudflare/cloudflare-connection-repository';
import { D1CloudflareCredentialVault } from '~/lib/.server/cloudflare/cloudflare-credential-vault';
import {
  CloudflareOAuthError,
  CloudflareOrchestratorUnavailableError,
  createCloudflareOrchestrator,
  type CloudflareOrchestrator,
} from '~/lib/.server/cloudflare/cloudflare-orchestrator';

const requestedCapabilities = ['workers', 'd1', 'r2', 'durable_objects', 'workers_ai'] as const;
export const CLOUDFLARE_CONNECTION_CALLBACK_METHOD = 'GET' as const;
const OAUTH_STATE_COOKIE = 'ghostbuild_oauth_state';
const OAUTH_STATE_COOKIE_MAX_AGE_SECONDS = 10 * 60;
const startPayloadSchema = z.object({ callbackURL: z.string().url().max(2_048).optional() });
const callbackPayloadSchema = z
  .object({
    state: z.string().uuid(),
    code: z.string().min(1).optional(),
    error: z.string().min(1).optional(),
    error_description: z.string().optional(),
    scope: z.string().optional(),
  })
  .refine((payload) => Boolean(payload.code || payload.error), 'An OAuth code or error is required.');
const challengeSchema = z.object({
  sessionId: z.string().min(1),
  authorizationUrl: z
    .string()
    .url()
    .refine((value) => new URL(value).protocol === 'https:', 'HTTPS is required'),
  expiresAt: z.number().int().positive(),
});
const connectionResultSchema = z.object({
  user: z.object({
    subject: z.string().min(1),
    email: z.string().email().nullable(),
    name: z.string().min(1).nullable(),
    picture: z.string().url().nullable(),
  }),
  accountId: z.string().min(1),
  accountName: z.string().min(1).nullable(),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  accessTokenExpiresAt: z.number().int().positive().optional(),
  grantedCapabilities: z.array(z.enum(requestedCapabilities)),
});

export async function cloudflareConnectionStatusAction({
  request,
  env,
}: {
  request: Request;
  env: Env;
}): Promise<Response> {
  const session = await getAuthSession(env, request);
  if (!session) {
    return Response.json({ error: 'Cloudflare authentication required.' }, { status: 401 });
  }

  const connection = await findCloudflareConnectionForUser(env.DB, session.user.id);
  if (!connection || connection.status !== 'active') {
    return Response.json({ error: 'An active Cloudflare account is required.' }, { status: 401 });
  }

  return Response.json({
    connected: true,
    status: connection.status,
    accountName: connection.accountName,
    aiBillingEnabled: connection.aiBillingEnabled,
    connectedAt: connection.connectedAt,
  });
}

export async function startCloudflareConnectionAction(args: {
  request: Request;
  env: Env;
  orchestrator?: CloudflareOrchestrator;
}): Promise<Response> {
  try {
    if (!hasSameOrigin(args.request)) {
      return Response.json({ error: 'Invalid request origin.' }, { status: 403 });
    }
    const payload = startPayloadSchema.parse(await args.request.json().catch(() => ({})));
    const state = crypto.randomUUID();
    const requestUrl = new URL(args.request.url);
    const returnUrl = new URL('/connect/return', requestUrl.origin);
    returnUrl.searchParams.set('state', state);
    const orchestrator = args.orchestrator ?? (await createCloudflareOrchestrator(args.env));
    const challenge = challengeSchema.parse(
      await orchestrator.startConnection({
        returnUrl: returnUrl.toString(),
        requestedCapabilities: [...requestedCapabilities],
      }),
    );
    const now = Date.now();
    if (challenge.expiresAt <= now) {
      throw new Error('Cloudflare returned an expired authorization challenge.');
    }
    await args.env.DB.prepare(
      `INSERT INTO cloudflare_oauth_states
        (id, provider_session_id, return_to, status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
    )
      .bind(
        state,
        challenge.sessionId,
        safeReturnTo(payload.callbackURL, requestUrl.origin),
        challenge.expiresAt,
        now,
        now,
      )
      .run();
    return Response.json(
      { authorizationUrl: challenge.authorizationUrl, expiresAt: challenge.expiresAt },
      {
        status: 201,
        headers: { 'Set-Cookie': oauthStateCookie(state, OAUTH_STATE_COOKIE_MAX_AGE_SECONDS, args.request) },
      },
    );
  } catch (error) {
    return cloudflareIntegrationErrorResponse(error);
  }
}

export async function completeCloudflareConnectionAction(args: {
  request: Request;
  env: Env;
  orchestrator?: CloudflareOrchestrator;
}): Promise<Response> {
  try {
    const { state, callbackUrl } = await readCloudflareCallback(args.request);
    if (readCookie(args.request, OAUTH_STATE_COOKIE) !== state) {
      return Response.json({ error: 'Cloudflare authorization browser state did not match.' }, { status: 400 });
    }
    const oauthState = await args.env.DB.prepare(
      `SELECT provider_session_id, return_to, expires_at
       FROM cloudflare_oauth_states
       WHERE id = ? AND status = 'pending'`,
    )
      .bind(state)
      .first<{ provider_session_id: string; return_to: string; expires_at: number }>();
    if (!oauthState) {
      return Response.json({ error: 'Cloudflare authorization session not found.' }, { status: 404 });
    }
    if (oauthState.expires_at <= Date.now()) {
      await args.env.DB.prepare(
        `UPDATE cloudflare_oauth_states SET status = 'expired', updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
        .bind(Date.now(), state)
        .run();
      return Response.json({ error: 'Cloudflare authorization session expired.' }, { status: 410 });
    }
    if (!args.env.CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY) {
      throw new Error('Cloudflare credential encryption is not configured.');
    }

    const orchestrator = args.orchestrator ?? (await createCloudflareOrchestrator(args.env));
    const result = connectionResultSchema.parse(
      await orchestrator.completeConnection({
        providerSessionId: oauthState.provider_session_id,
        callbackUrl,
      }),
    );
    const user = await upsertCloudflareUser(args.env.DB, result.user, result.accountName);
    const previous = await findCloudflareConnectionForUser(args.env.DB, user.id);
    const vault = D1CloudflareCredentialVault.fromEnv(args.env);
    const credentialHandle = result.refreshToken
      ? await vault.storeOAuthCredential({
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          expiresAt: result.accessTokenExpiresAt ?? Date.now(),
        })
      : await vault.store(result.accessToken);
    try {
      await activateCloudflareConnection({
        db: args.env.DB,
        userId: user.id,
        accountId: result.accountId,
        accountName: result.accountName,
        credentialHandle,
        grantedScopes: result.grantedCapabilities,
        aiBillingEnabled: result.grantedCapabilities.includes('workers_ai'),
      });
      await args.env.DB.prepare(
        `UPDATE cloudflare_oauth_states SET status = 'completed', updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
        .bind(Date.now(), state)
        .run();
    } catch (error) {
      await vault.delete(credentialHandle).catch(() => undefined);
      throw error;
    }
    if (previous?.credentialHandle && previous.credentialHandle !== credentialHandle) {
      await vault.delete(previous.credentialHandle).catch(() => undefined);
    }
    const sessionCookie = await createAuthSession(args.env, user.id, args.request);
    const headers = new Headers({
      Location: new URL(oauthState.return_to, args.request.url).toString(),
      'Set-Cookie': sessionCookie,
    });
    headers.append('Set-Cookie', oauthStateCookie('', 0, args.request));
    return new Response(null, {
      status: 303,
      headers,
    });
  } catch (error) {
    return cloudflareIntegrationErrorResponse(error);
  }
}

async function readCloudflareCallback(request: Request): Promise<{ state: string; callbackUrl: string }> {
  const requestUrl = new URL(request.url);
  const params =
    request.method === 'POST' ? new URLSearchParams(await request.text()) : new URLSearchParams(requestUrl.search);
  const payload = callbackPayloadSchema.parse(Object.fromEntries(params));
  const callbackUrl = new URL(requestUrl.pathname, requestUrl.origin);
  for (const key of ['state', 'code', 'error', 'error_description', 'scope'] as const) {
    const value = payload[key];
    if (value) {
      callbackUrl.searchParams.set(key, value);
    }
  }
  return { state: payload.state, callbackUrl: callbackUrl.toString() };
}

function safeReturnTo(callbackURL: string | undefined, origin: string): string {
  if (!callbackURL) {
    return '/';
  }
  const callback = new URL(callbackURL, origin);
  return callback.origin === origin ? `${callback.pathname}${callback.search}${callback.hash}` : '/';
}

function hasSameOrigin(request: Request): boolean {
  return request.headers.get('origin') === new URL(request.url).origin;
}

function oauthStateCookie(value: string, maxAge: number, request: Request): string {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${OAUTH_STATE_COOKIE}=${encodeURIComponent(value)}; Path=/connect/return; HttpOnly${secure}; SameSite=Lax; Max-Age=${maxAge}`;
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [candidate, ...value] = part.trim().split('=');
    if (candidate !== name) {
      continue;
    }
    try {
      return decodeURIComponent(value.join('='));
    } catch {
      return null;
    }
  }
  return null;
}

function cloudflareIntegrationErrorResponse(error: unknown): Response {
  if (error instanceof CloudflareOrchestratorUnavailableError) {
    return Response.json({ error: 'Cloudflare OAuth is not configured for this environment.' }, { status: 503 });
  }
  if (error instanceof CloudflareOAuthError) {
    return Response.json({ error: error.message }, { status: 400 });
  }
  if (error instanceof z.ZodError) {
    return Response.json({ error: 'Invalid Cloudflare authorization response.' }, { status: 502 });
  }
  console.error('Cloudflare authorization failed', error);
  return Response.json({ error: 'Cloudflare authorization failed.' }, { status: 500 });
}
