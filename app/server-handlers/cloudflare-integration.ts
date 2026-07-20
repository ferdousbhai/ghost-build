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
import {
  APP_AGENT_SECURITY_BOUNDARY_SHA256,
  DEPLOYMENT_SECURITY_BASELINE_VERSION,
  TEMPLATE_SOURCE_SHA256,
} from '~/lib/.server/cloudflare/deployment-security-baseline';
import { InvalidJsonBodyError, PayloadTooLargeError, readJsonBodyWithLimit } from '~/lib/bounded-body';

const requestedCapabilities = ['workers', 'd1', 'r2', 'durable_objects', 'workers_ai'] as const;
export const CLOUDFLARE_CONNECTION_CALLBACK_METHOD = 'GET' as const;
const OAUTH_STATE_COOKIE = 'ghostbuild_oauth_state';
const OAUTH_STATE_COOKIE_MAX_AGE_SECONDS = 10 * 60;
const OAUTH_START_RATE_LIMIT_RETRY_SECONDS = 60;
const MAX_OAUTH_START_REQUEST_BYTES = 4 * 1024;
const MAX_OAUTH_CALLBACK_CODE_LENGTH = 4_096;
const MAX_OAUTH_CALLBACK_TEXT_LENGTH = 2_048;
const DEPLOYMENT_SECURITY_PAGE_SIZE = 25;
const startPayloadSchema = z.object({ callbackURL: z.string().url().max(2_048).optional() });
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

type DeploymentSecurityInventoryRow = {
  is_managed: number;
  deployment_id: string | null;
  production_url: string | null;
  status: 'current' | 'legacy_candidate' | 'drifted' | 'unreachable' | 'not_found';
  expected_template_source_sha256: string | null;
  expected_security_baseline_version: number | null;
  expected_security_boundary_sha256: string | null;
  last_checked_at: number;
  worker_name: string;
};

type DeploymentSecurityItem = {
  scope: 'managed' | 'historical';
  state: 'current' | 'upgrade_available' | 'user_action_required' | 'verification_failed' | 'not_applicable';
  deploymentId: string | null;
  productionUrl: string | null;
  checkedAt: number | null;
  workerName: string | null;
  remediation:
    | { kind: 'replace_from_fresh_builder'; builderPath: '/'; manualCleanupRequired: true }
    | { kind: 'reauthorize_cloudflare' }
    | null;
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

  let deploymentSecurityCursor: string | null;
  try {
    deploymentSecurityCursor = parseDeploymentSecurityCursor(request);
  } catch {
    return Response.json({ error: 'Invalid deployment security cursor.' }, { status: 400 });
  }
  const deploymentSecurity = await readOwnerDeploymentSecurity({
    db: env.DB,
    userId: session.user.id,
    connectionId: connection.id,
    cursor: deploymentSecurityCursor,
  });

  return Response.json(
    {
      connected: true,
      status: connection.status,
      accountName: connection.accountName,
      aiBillingEnabled: connection.aiBillingEnabled,
      connectedAt: connection.connectedAt,
      deploymentSecurity,
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}

async function readOwnerDeploymentSecurity(args: {
  db: D1Database;
  userId: string;
  connectionId: string;
  cursor: string | null;
}): Promise<{
  state: 'current' | 'action_required' | 'checking' | 'none';
  items: DeploymentSecurityItem[];
  hasMore: boolean;
  nextCursor: string | null;
}> {
  try {
    // Tenant scoping happens inside the bounded CTE before any deployment join.
    // worker_name is the immutable second half of the inventory primary key, so
    // scheduled status refreshes cannot reorder rows between continuation reads.
    // The join repeats both ownership predicates so a corrupt inventory link
    // cannot disclose another user's deployment metadata.
    const result = await args.db
      .prepare(
        `WITH scoped_inventory AS (
           SELECT managed_deployment_id, status,
                  expected_template_source_sha256, expected_security_baseline_version,
                  expected_security_boundary_sha256, last_checked_at, worker_name
           FROM deployment_security_inventory
           WHERE user_id = ? AND connection_id = ?
             AND (? IS NULL OR worker_name > ?)
           ORDER BY worker_name
           LIMIT ?
         )
         SELECT CASE WHEN inventory.managed_deployment_id IS NULL THEN 0 ELSE 1 END AS is_managed,
                deployment.id AS deployment_id, deployment.production_url,
                inventory.status, inventory.expected_template_source_sha256,
                inventory.expected_security_baseline_version,
                inventory.expected_security_boundary_sha256, inventory.last_checked_at,
                inventory.worker_name
         FROM scoped_inventory AS inventory
         LEFT JOIN deployments AS deployment
           ON deployment.id = inventory.managed_deployment_id
          AND deployment.user_id = ?
          AND deployment.connection_id = ?
         ORDER BY inventory.worker_name`,
      )
      .bind(
        args.userId,
        args.connectionId,
        args.cursor,
        args.cursor,
        DEPLOYMENT_SECURITY_PAGE_SIZE + 1,
        args.userId,
        args.connectionId,
      )
      .all<DeploymentSecurityInventoryRow>();
    const hasMore = result.results.length > DEPLOYMENT_SECURITY_PAGE_SIZE;
    const visibleRows = result.results.slice(0, DEPLOYMENT_SECURITY_PAGE_SIZE);
    const hasPendingDiscovery =
      (args.cursor === null && result.results.length === 0) || visibleRows.some((row) => row.last_checked_at <= 0);
    const items = visibleRows.filter((row) => row.last_checked_at > 0).map(deploymentSecurityItemFromRow);
    const requiresAction = items.some((item) =>
      ['upgrade_available', 'user_action_required', 'verification_failed'].includes(item.state),
    );
    return {
      state: requiresAction
        ? 'action_required'
        : hasPendingDiscovery || hasMore
          ? 'checking'
          : items.some((item) => item.state === 'current')
            ? 'current'
            : 'none',
      items,
      hasMore,
      nextCursor: hasMore ? (visibleRows.at(-1)?.worker_name ?? null) : null,
    };
  } catch (error) {
    console.error('Unable to read deployment security status', error);
    return { state: 'checking', items: [], hasMore: false, nextCursor: null };
  }
}

function deploymentSecurityItemFromRow(row: DeploymentSecurityInventoryRow): DeploymentSecurityItem {
  const scope: DeploymentSecurityItem['scope'] = row.is_managed === 1 ? 'managed' : 'historical';
  const hasCurrentIdentity =
    row.expected_template_source_sha256 === TEMPLATE_SOURCE_SHA256 &&
    row.expected_security_baseline_version === DEPLOYMENT_SECURITY_BASELINE_VERSION &&
    row.expected_security_boundary_sha256 === APP_AGENT_SECURITY_BOUNDARY_SHA256;
  const base = {
    scope,
    deploymentId: row.deployment_id,
    productionUrl: safeHttpsUrl(row.production_url),
    checkedAt: row.last_checked_at > 0 ? row.last_checked_at : null,
    workerName: safeWorkerName(row.worker_name),
  };

  if (row.status === 'unreachable') {
    return { ...base, state: 'verification_failed', remediation: { kind: 'reauthorize_cloudflare' } };
  }
  if (row.status === 'not_found') {
    return { ...base, state: 'not_applicable', remediation: null };
  }
  if (row.status === 'drifted') {
    return { ...base, state: 'user_action_required', remediation: secureReplacementRemediation() };
  }
  if (scope === 'managed' && row.status === 'current' && hasCurrentIdentity) {
    return { ...base, state: 'current', remediation: null };
  }
  if (scope === 'managed' && (row.status === 'legacy_candidate' || !hasCurrentIdentity)) {
    return { ...base, state: 'upgrade_available', remediation: secureReplacementRemediation() };
  }
  return { ...base, state: 'user_action_required', remediation: secureReplacementRemediation() };
}

function parseDeploymentSecurityCursor(request: Request): string | null {
  const values = new URL(request.url).searchParams.getAll('deploymentSecurityCursor');
  if (values.length === 0) {
    return null;
  }
  if (values.length !== 1 || safeWorkerName(values[0]!) === null) {
    throw new InvalidCloudflareIntegrationRequestError();
  }
  return values[0]!;
}

function safeWorkerName(value: string): string | null {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value) ? value : null;
}

function secureReplacementRemediation() {
  return { kind: 'replace_from_fresh_builder', builderPath: '/', manualCleanupRequired: true } as const;
}

function safeHttpsUrl(value: string | null): string | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
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
