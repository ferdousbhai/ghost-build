import { z } from 'zod';
import { createAuthSession, getAuthSession, prepareAuthSession, upsertCloudflareUser } from '~/lib/.server/auth';
import {
  activateCloudflareConnection,
  CloudflareConnectionChangedError,
  findCloudflareConnectionForUser,
  type CloudflareConnection,
} from '~/lib/.server/cloudflare/cloudflare-connection-repository';
import { D1CloudflareCredentialVault } from '~/lib/.server/cloudflare/cloudflare-credential-vault';
import {
  CloudflareOAuthError,
  CloudflareOrchestratorUnavailableError,
  createCloudflareOrchestrator,
  type CloudflareOrchestrator,
} from '~/lib/.server/cloudflare/cloudflare-orchestrator';
import { InvalidJsonBodyError, PayloadTooLargeError, readJsonBodyWithLimit } from '~/lib/bounded-body';
import { provisionUserWorkspaceRuntime } from '~/lib/.server/cloudflare/user-workspace-runtime-provisioner';
import { findUserWorkspaceRuntime } from '~/lib/.server/cloudflare/user-workspace-runtime-repository';
import { USER_WORKSPACE_RUNTIME_SHA256 } from '~/generated/user-workspace-runtime.generated';
import { deriveUserWorkspaceRuntimeSecret } from '~/lib/.server/cloudflare/user-workspace-runtime-secret';
import { mintRuntimeCapability } from '~/lib/cloudflare/runtime-capability';

const requestedCapabilities = ['workers', 'containers', 'd1', 'r2', 'durable_objects', 'workers_ai'] as const;
export const CLOUDFLARE_CONNECTION_CALLBACK_METHOD = 'GET' as const;
const OAUTH_STATE_COOKIE = 'ghostbuild_oauth_state';
const OAUTH_STATE_COOKIE_MAX_AGE_SECONDS = 10 * 60;
const OAUTH_START_RATE_LIMIT_RETRY_SECONDS = 60;
const MAX_OAUTH_START_REQUEST_BYTES = 4 * 1024;
const MAX_OAUTH_CALLBACK_CODE_LENGTH = 4_096;
const MAX_OAUTH_CALLBACK_TEXT_LENGTH = 2_048;
const MAX_WORKSPACE_RUNTIME_SETUP_BYTES = 2 * 1024;
const startPayloadSchema = z.object({ callbackURL: z.string().url().max(2_048).optional() });
const workspaceRuntimeSetupSchema = z.object({
  r2AccessKeyId: z.string().min(16).max(128),
  r2SecretAccessKey: z.string().min(32).max(256),
});
const callbackPayloadSchema = z
  .object({
    state: z.string().uuid(),
    code: z.string().min(1).max(MAX_OAUTH_CALLBACK_CODE_LENGTH).optional(),
    error: z.string().min(1).max(MAX_OAUTH_CALLBACK_TEXT_LENGTH).optional(),
    error_description: z.string().max(MAX_OAUTH_CALLBACK_TEXT_LENGTH).optional(),
    scope: z.string().max(MAX_OAUTH_CALLBACK_TEXT_LENGTH).optional(),
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
type PendingOAuthState = {
  provider_session_id: string;
  return_to: string;
  expires_at: number;
  authenticated_user_id: string | null;
};

class InvalidCloudflareIntegrationRequestError extends Error {}

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

  const workspaceRuntime = await findUserWorkspaceRuntime(env.DB, session.user.id).catch(() => null);

  return Response.json(
    {
      connected: true,
      status: connection.status,
      accountName: connection.accountName,
      aiBillingEnabled: connection.aiBillingEnabled,
      connectedAt: connection.connectedAt,
      workspaceRuntime: workspaceRuntime
        ? {
            status: workspaceRuntime.status,
            current:
              workspaceRuntime.connectionId === connection.id &&
              workspaceRuntime.connectionGeneration === connection.generation &&
              workspaceRuntime.runtimeVersion === USER_WORKSPACE_RUNTIME_SHA256,
            lastError: workspaceRuntime.lastError,
          }
        : { status: 'not_configured', current: false, lastError: null },
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}

export async function cloudflareRuntimeSessionAction({
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
  const [connection, runtime] = await Promise.all([
    findCloudflareConnectionForUser(env.DB, session.user.id),
    findUserWorkspaceRuntime(env.DB, session.user.id),
  ]);
  if (
    !connection ||
    connection.status !== 'active' ||
    !runtime ||
    runtime.status !== 'ready' ||
    runtime.connectionId !== connection.id ||
    runtime.connectionGeneration !== connection.generation ||
    runtime.runtimeVersion !== USER_WORKSPACE_RUNTIME_SHA256
  ) {
    return Response.json(
      { error: 'Set up the current user-owned Ghostbuild runtime before opening a project.' },
      { status: 409 },
    );
  }
  if (!env.CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY) {
    return Response.json({ error: 'Runtime authorization is unavailable.' }, { status: 503 });
  }
  const secret = await deriveUserWorkspaceRuntimeSecret({
    encryptionKeyBase64: env.CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY,
    userId: session.user.id,
    accountId: connection.accountId,
    connectionGeneration: connection.generation,
  });
  const capability = await mintRuntimeCapability({
    secret,
    subject: session.user.id,
    origin: new URL(request.url).origin,
  });
  return Response.json(
    { endpoint: runtime.endpoint, ...capability },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}

export async function provisionCloudflareWorkspaceRuntimeAction(args: {
  request: Request;
  env: Env;
}): Promise<Response> {
  try {
    if (!hasSameOrigin(args.request)) {
      return Response.json({ error: 'Invalid request origin.' }, { status: 403 });
    }
    const session = await getAuthSession(args.env, args.request);
    if (!session) {
      return Response.json({ error: 'Cloudflare authentication required.' }, { status: 401 });
    }
    const connection = await findCloudflareConnectionForUser(args.env.DB, session.user.id);
    if (!connection || connection.status !== 'active') {
      return Response.json({ error: 'Connect Cloudflare before configuring project storage.' }, { status: 409 });
    }
    const payload = parseIntegrationRequest(
      workspaceRuntimeSetupSchema,
      await readJsonBodyWithLimit(
        args.request,
        MAX_WORKSPACE_RUNTIME_SETUP_BYTES,
        'Cloudflare workspace runtime setup',
      ),
    );
    const runtime = await provisionUserWorkspaceRuntime({
      env: args.env,
      userId: session.user.id,
      connectionId: connection.id,
      r2AccessKeyId: payload.r2AccessKeyId,
      r2SecretAccessKey: payload.r2SecretAccessKey,
    });
    return Response.json(
      {
        status: runtime.status,
        current: runtime.runtimeVersion === USER_WORKSPACE_RUNTIME_SHA256,
      },
      { status: 201, headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return Response.json({ error: error.message }, { status: 413 });
    }
    if (
      error instanceof InvalidJsonBodyError ||
      error instanceof InvalidCloudflareIntegrationRequestError ||
      error instanceof z.ZodError
    ) {
      return Response.json({ error: 'Invalid R2 backup credentials.' }, { status: 400 });
    }
    console.error('User-owned Cloudflare workspace runtime provisioning failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { error: error instanceof Error ? error.message : 'Cloudflare workspace runtime provisioning failed.' },
      { status: 502 },
    );
  }
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
    const { success } = await args.env.CLOUDFLARE_OAUTH_START_RATE_LIMITER.limit({
      key: args.request.headers.get('CF-Connecting-IP') ?? 'unknown',
    });
    if (!success) {
      return Response.json(
        { error: 'Too many Cloudflare authorization attempts. Try again shortly.' },
        {
          status: 429,
          headers: {
            'Retry-After': String(OAUTH_START_RATE_LIMIT_RETRY_SECONDS),
            'Cache-Control': 'no-store',
          },
        },
      );
    }
    const payload = parseIntegrationRequest(
      startPayloadSchema,
      await readJsonBodyWithLimit(args.request, MAX_OAUTH_START_REQUEST_BYTES, 'Cloudflare authorization request'),
    );
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
      `SELECT provider_session_id, return_to, expires_at, authenticated_user_id
       FROM cloudflare_oauth_states
       WHERE id = ? AND status = 'pending'`,
    )
      .bind(state)
      .first<PendingOAuthState>();
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

    let userId = oauthState.authenticated_user_id;
    if (userId) {
      const connection = await findCloudflareConnectionForUser(args.env.DB, userId);
      if (connection?.status !== 'active' || !connection.credentialHandle) {
        throw new Error('Cloudflare authorization checkpoint no longer has an active connection.');
      }
    } else {
      const orchestrator = args.orchestrator ?? (await createCloudflareOrchestrator(args.env));
      const result = connectionResultSchema.parse(
        await orchestrator.completeConnection({
          providerSessionId: oauthState.provider_session_id,
          callbackUrl,
        }),
      );
      const user = await upsertCloudflareUser(args.env.DB, result.user, result.accountName);
      userId = user.id;
      const previous = await findCloudflareConnectionForUser(args.env.DB, userId);
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
          userId,
          accountId: result.accountId,
          accountName: result.accountName,
          credentialHandle,
          grantedScopes: result.grantedCapabilities,
          aiBillingEnabled: result.grantedCapabilities.includes('workers_ai'),
          expectedGeneration: previous?.generation ?? null,
        });
      } catch (error) {
        const racedConnection =
          error instanceof CloudflareConnectionChangedError
            ? await findCloudflareConnectionForUser(args.env.DB, userId).catch(() => null)
            : null;
        const canAdoptRace =
          racedConnection && isEquivalentRacedConnection(racedConnection, userId, result, previous?.generation ?? null);
        await vault.deleteIfUnreferenced(credentialHandle).catch(() => undefined);
        if (!canAdoptRace) {
          throw error;
        }
      }
      if (previous?.credentialHandle && previous.credentialHandle !== credentialHandle) {
        await vault.deleteIfUnreferenced(previous.credentialHandle).catch(() => undefined);
      }
      await checkpointAuthenticatedOAuthUser({
        db: args.env.DB,
        stateId: state,
        expected: oauthState,
        userId,
      });
    }
    const preparedSession = await prepareAuthSession(userId, args.request);
    const sessionCookie = await createAuthSession(args.env, preparedSession);
    await completeOAuthState({ db: args.env.DB, stateId: state, expected: oauthState, userId });
    const headers = new Headers({
      Location: new URL(
        safeReturnTo(oauthState.return_to, new URL(args.request.url).origin),
        args.request.url,
      ).toString(),
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

function isEquivalentRacedConnection(
  connection: CloudflareConnection,
  userId: string,
  result: z.infer<typeof connectionResultSchema>,
  expectedGeneration: number | null,
): boolean {
  return (
    connection.status === 'active' &&
    connection.userId === userId &&
    connection.credentialHandle !== null &&
    connection.accountId === result.accountId &&
    connection.accountName === result.accountName &&
    connection.generation === (expectedGeneration ?? 0) + 1 &&
    connection.aiBillingEnabled === result.grantedCapabilities.includes('workers_ai') &&
    connection.grantedScopes.length === result.grantedCapabilities.length &&
    connection.grantedScopes.every((scope, index) => scope === result.grantedCapabilities[index])
  );
}

async function checkpointAuthenticatedOAuthUser(args: {
  db: D1Database;
  stateId: string;
  expected: PendingOAuthState;
  userId: string;
}): Promise<void> {
  const updatedAt = Date.now();
  try {
    const result = await args.db
      .prepare(
        `UPDATE cloudflare_oauth_states SET authenticated_user_id = ?, updated_at = ?
         WHERE id = ? AND status = 'pending' AND authenticated_user_id IS NULL
           AND provider_session_id = ? AND return_to = ? AND expires_at = ?`,
      )
      .bind(
        args.userId,
        updatedAt,
        args.stateId,
        args.expected.provider_session_id,
        args.expected.return_to,
        args.expected.expires_at,
      )
      .run();
    if (result.meta.changes === 1) {
      return;
    }
  } catch (error) {
    if (await isExactOAuthCheckpoint(args.db, args.stateId, args.expected, args.userId, updatedAt).catch(() => false)) {
      return;
    }
    throw error;
  }
  if (await isExactOAuthCheckpoint(args.db, args.stateId, args.expected, args.userId, updatedAt)) {
    return;
  }
  throw new Error('Cloudflare authorization state changed while authentication was being checkpointed.');
}

async function completeOAuthState(args: {
  db: D1Database;
  stateId: string;
  expected: PendingOAuthState;
  userId: string;
}): Promise<void> {
  const updatedAt = Date.now();
  try {
    const result = await args.db
      .prepare(
        `UPDATE cloudflare_oauth_states SET status = 'completed', updated_at = ?
         WHERE id = ? AND status = 'pending' AND provider_session_id = ? AND return_to = ?
           AND expires_at = ? AND authenticated_user_id = ?`,
      )
      .bind(
        updatedAt,
        args.stateId,
        args.expected.provider_session_id,
        args.expected.return_to,
        args.expected.expires_at,
        args.userId,
      )
      .run();
    if (result.meta.changes === 1) {
      return;
    }
  } catch (error) {
    if (
      await isExactCompletedOAuthState(args.db, args.stateId, args.expected, args.userId, updatedAt).catch(() => false)
    ) {
      return;
    }
    throw error;
  }
  if (await isExactCompletedOAuthState(args.db, args.stateId, args.expected, args.userId, updatedAt)) {
    return;
  }
  throw new Error('Cloudflare authorization state changed while completion was being persisted.');
}

async function isExactOAuthCheckpoint(
  db: D1Database,
  stateId: string,
  expected: PendingOAuthState,
  userId: string,
  updatedAt: number,
): Promise<boolean> {
  const row = await readOAuthState(db, stateId);
  if (!row) {
    return false;
  }
  return (
    row.provider_session_id === expected.provider_session_id &&
    row.return_to === expected.return_to &&
    row.status === 'pending' &&
    row.expires_at === expected.expires_at &&
    row.authenticated_user_id === userId &&
    row.updated_at === updatedAt
  );
}

async function isExactCompletedOAuthState(
  db: D1Database,
  stateId: string,
  expected: PendingOAuthState,
  userId: string,
  updatedAt: number,
): Promise<boolean> {
  const row = await readOAuthState(db, stateId);
  if (!row) {
    return false;
  }
  return (
    row.provider_session_id === expected.provider_session_id &&
    row.return_to === expected.return_to &&
    row.status === 'completed' &&
    row.expires_at === expected.expires_at &&
    row.authenticated_user_id === userId &&
    row.updated_at === updatedAt
  );
}

async function readOAuthState(db: D1Database, stateId: string) {
  return db
    .prepare(
      `SELECT provider_session_id, return_to, status, expires_at, authenticated_user_id, updated_at
       FROM cloudflare_oauth_states
       WHERE id = ?`,
    )
    .bind(stateId)
    .first<PendingOAuthState & { status: string; updated_at: number }>();
}

async function readCloudflareCallback(request: Request): Promise<{ state: string; callbackUrl: string }> {
  const requestUrl = new URL(request.url);
  const payload = parseIntegrationRequest(callbackPayloadSchema, Object.fromEntries(requestUrl.searchParams));
  const callbackUrl = new URL(requestUrl.pathname, requestUrl.origin);
  for (const key of ['state', 'code', 'error', 'error_description', 'scope'] as const) {
    const value = payload[key];
    if (value) {
      callbackUrl.searchParams.set(key, value);
    }
  }
  return { state: payload.state, callbackUrl: callbackUrl.toString() };
}

function parseIntegrationRequest<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new InvalidCloudflareIntegrationRequestError('Invalid Cloudflare authorization request.');
  }
  return result.data;
}

function safeReturnTo(callbackURL: string | undefined, origin: string): string {
  if (!callbackURL) {
    return '/';
  }
  const callback = new URL(callbackURL, origin);
  if (callback.origin !== origin || callback.pathname.startsWith('//')) {
    return '/';
  }
  const returnTo = `${callback.pathname}${callback.search}${callback.hash}`;
  return returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/';
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
  if (error instanceof PayloadTooLargeError) {
    return Response.json({ error: error.message }, { status: 413 });
  }
  if (error instanceof InvalidJsonBodyError) {
    return Response.json({ error: 'Invalid Cloudflare authorization request.' }, { status: 400 });
  }
  if (error instanceof InvalidCloudflareIntegrationRequestError) {
    return Response.json({ error: error.message }, { status: 400 });
  }
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
