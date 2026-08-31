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
import {
  missingUserWorkspaceRuntimeCapabilities,
  provisionUserWorkspaceRuntime,
  USER_WORKSPACE_REQUIRED_CAPABILITIES,
  UserWorkspaceContainersEligibilityUnknownError,
  UserWorkspaceContainersPlanRequiredError,
  UserWorkspaceRuntimeProvisioningInProgressError,
} from '~/lib/.server/cloudflare/user-workspace-runtime-provisioner';
import {
  findUserWorkspaceRuntime,
  recordUserWorkspaceRuntimeUpgradeDeferral,
  type UserWorkspaceRuntime,
} from '~/lib/.server/cloudflare/user-workspace-runtime-repository';
import { readUserWorkspaceRuntimeActivity } from '~/lib/.server/cloudflare/user-workspace-runtime-activity';
import { USER_WORKSPACE_RUNTIME_SHA256 } from '~/generated/user-workspace-runtime.generated';
import { deriveUserWorkspaceRuntimeSecret } from '~/lib/.server/cloudflare/user-workspace-runtime-secret';
import { cloudflareWorkspaceImageReferenceOrNull } from '~/lib/.server/cloudflare/workspace-image-reference';
import { mintRuntimeCapability } from '~/lib/cloudflare/runtime-capability';
import {
  CLOUDFLARE_AUTHORIZATION_ERROR_PARAM,
  CLOUDFLARE_AUTHORIZATION_ERROR_VALUE,
} from '~/lib/cloudflare/authorization-recovery';
import { isWorkspacePlanRequiredMessage, UserCloudflareAccountApi } from '~/lib/.server/cloudflare/user-account-api';
import type { AiGatewayCreditStatus } from '~/lib/cloudflare/ai-gateway-credit';

type WorkspacePreparationFailure = {
  code: 'workspace_plan_required' | 'workspace_preparation_failed';
  error: string;
  upgradeUrl?: string;
};

const requestedCapabilities = USER_WORKSPACE_REQUIRED_CAPABILITIES;
export const CLOUDFLARE_CONNECTION_CALLBACK_METHOD = 'GET' as const;
const OAUTH_STATE_COOKIE = 'ghostbuild_oauth_state';
const OAUTH_STATE_COOKIE_MAX_AGE_SECONDS = 10 * 60;
const OAUTH_START_RATE_LIMIT_RETRY_SECONDS = 60;
const MAX_OAUTH_START_REQUEST_BYTES = 4 * 1024;
const MAX_OAUTH_CALLBACK_CODE_LENGTH = 4_096;
const MAX_OAUTH_CALLBACK_TEXT_LENGTH = 2_048;
const AI_GATEWAY_CREDIT_CHECK_TIMEOUT_MS = 5_000;
/**
 * How long a busy workspace may keep an old runtime. It exceeds the longest operation lease (the
 * 45-minute deployment lane), so no single operation that was already running when the drift
 * appeared is ever cut short by the bound; passing it means the workspace has been continuously
 * re-proving that work is in flight for over an hour, across several leases, and the upgrade stops
 * waiting. The interruption then lands on the journal and lane recovery that already name it.
 */
const MAX_RUNTIME_UPGRADE_DEFERRAL_MS = 60 * 60_000;
const WORKSPACE_PLAN_REQUIRED_MESSAGE =
  'Cloudflare Containers requires the Workers Paid plan. Enable Workers Paid in Cloudflare, then return here and try again. Ghostbuild does not change your plan automatically.';
const WORKSPACE_PREPARATION_FAILED_MESSAGE =
  'Cloudflare could not create your workspace. Check the Workers settings for this Cloudflare account, then try again.';
const WORKSPACE_ELIGIBILITY_UNKNOWN_MESSAGE =
  'Ghostbuild could not reach Cloudflare to confirm that this account can run Containers, so it did not start creating your workspace. Nothing changed in your Cloudflare account. Try again in a moment.';
const CLOUDFLARE_REAUTHORIZATION_REQUIRED_MESSAGE =
  'Ghostbuild needs updated Cloudflare permissions for this workspace. Reauthorize Cloudflare, approve the requested permissions, then try again.';
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
  requestedOAuthScopes: z.array(z.string().min(1)),
  grantedOAuthScopes: z.array(z.string().min(1)),
  oauthScopeProfileVersion: z.string().min(1),
  oauthScopeGrantStatus: z.enum(['unknown', 'core', 'partial', 'full']),
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

  return Response.json(
    {
      accountId: connection.accountId,
      accountName: connection.accountName,
      oauthScopeGrantStatus: connection.oauthScopeGrantStatus,
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}

// Long enough for the claim, entitlement probe, and any fast rejection to settle on the request;
// short enough that the multi-minute image copy is never awaited inline. Overshooting only costs an
// extra poll, so it is set generously rather than tuned.
const PROVISIONING_SYNC_BUDGET_MS = 8_000;

type ProvisioningSettlement = { status: 'fulfilled' } | { status: 'rejected'; reason: unknown } | { status: 'pending' };

/**
 * Await a provisioning run only up to the sync budget. A fast success or failure is returned so the
 * caller can answer synchronously; if the run is still going when the budget elapses it is reported
 * pending and left to finish under `waitUntil`. Both settlement outcomes are folded into the
 * returned value, so the underlying promise never rejects here regardless of which side of the race
 * wins.
 */
async function settleWithinProvisioningSyncBudget(provisioning: Promise<unknown>): Promise<ProvisioningSettlement> {
  const pending = Symbol('pending');
  const settled = provisioning.then<ProvisioningSettlement, ProvisioningSettlement>(
    () => ({ status: 'fulfilled' }),
    (reason) => ({ status: 'rejected', reason }),
  );
  const timeout = new Promise<typeof pending>((resolve) => {
    setTimeout(resolve, PROVISIONING_SYNC_BUDGET_MS, pending);
  });
  const raced = await Promise.race([settled, timeout]);
  return raced === pending ? { status: 'pending' } : raced;
}

export async function cloudflareRuntimeSessionAction({
  request,
  env,
  ctx,
  provision = provisionUserWorkspaceRuntime,
  readWorkspaceActivity = readUserWorkspaceRuntimeActivity,
  readAiGatewayCreditStatus,
}: {
  request: Request;
  env: Env;
  // The action only ever needs to detach provisioning from the request lifecycle, so it depends on
  // `waitUntil` alone rather than the full context.
  ctx?: Pick<ExecutionContext, 'waitUntil'>;
  provision?: typeof provisionUserWorkspaceRuntime;
  readWorkspaceActivity?: typeof readUserWorkspaceRuntimeActivity;
  readAiGatewayCreditStatus?: ReadAiGatewayCreditStatus;
}): Promise<Response> {
  if (!hasSameOrigin(request)) {
    return Response.json({ error: 'Invalid request origin.' }, { status: 403 });
  }
  const session = await getAuthSession(env, request);
  if (!session) {
    return Response.json({ error: 'Cloudflare authentication required.' }, { status: 401 });
  }
  const connection = await findCloudflareConnectionForUser(env.DB, session.user.id);
  if (!connection || connection.status !== 'active') {
    return Response.json({ error: 'Connect Cloudflare before opening a project.' }, { status: 409 });
  }
  if (!env.CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY) {
    return Response.json({ error: 'Runtime authorization is unavailable.' }, { status: 503 });
  }
  if (missingUserWorkspaceRuntimeCapabilities(connection).length > 0) {
    return Response.json(
      {
        code: 'cloudflare_reauthorization_required',
        error: CLOUDFLARE_REAUTHORIZATION_REQUIRED_MESSAGE,
      },
      { status: 409, headers: { 'Cache-Control': 'private, no-store' } },
    );
  }
  const runtime = await findUserWorkspaceRuntime(env.DB, session.user.id);
  // Upgrading resets the workspace Durable Objects, so a workspace that is mid-operation keeps the
  // runtime it is running on until it goes quiet or the deferral bound runs out.
  const upgradeNeeded = !isCurrentWorkspaceRuntime(runtime, connection);
  const upgradeDeferred =
    upgradeNeeded &&
    (await deferRuntimeUpgradeWhileWorkspaceIsBusy({
      env,
      userId: session.user.id,
      runtime,
      connection,
      readWorkspaceActivity,
    }));
  if (upgradeNeeded && !upgradeDeferred) {
    const provisioning = provision({
      env,
      userId: session.user.id,
      connectionId: connection.id,
    });
    // Provisioning is a single multi-minute call that converges the runtime row to `ready` or
    // `error` only if it runs to completion. Riding the client request used to strand it: a browser
    // that navigated away mid-copy killed the fiber with the row still holding a 40-minute lease, so
    // every later poll saw `workspace_preparing` until the lease expired. `waitUntil` detaches the
    // work from the connection so it always reaches a terminal state. Provision persists its own
    // failures, so the rejection is swallowed here only to keep it from surfacing as unhandled.
    ctx?.waitUntil(provisioning.catch(() => undefined));
    // The cheap, early outcomes — in-progress, plan-required, eligibility-unknown — all settle
    // before the image copy, so a short budget still answers them on this request. Past it the copy
    // owns the wall clock: hand the client `workspace_preparing` and let it poll while waitUntil
    // carries the copy to completion.
    const settlement = await settleWithinProvisioningSyncBudget(provisioning);
    if (settlement.status === 'pending') {
      return Response.json(
        { code: 'workspace_preparing', error: 'Ghostbuild is preparing your workspace.' },
        { status: 409, headers: { 'Cache-Control': 'private, no-store' } },
      );
    }
    if (settlement.status === 'rejected') {
      const error = settlement.reason;
      if (error instanceof UserWorkspaceRuntimeProvisioningInProgressError) {
        return Response.json(
          { code: 'workspace_preparing', error: error.message },
          { status: 409, headers: { 'Cache-Control': 'private, no-store' } },
        );
      }
      // An eligibility answer Ghostbuild could not read is its own outcome. Reporting it as a plan
      // problem would send the user to buy a plan they may already have; reporting it as a
      // preparation fault would hide that nothing was even attempted.
      if (error instanceof UserWorkspaceContainersEligibilityUnknownError) {
        console.error('Cloudflare Containers eligibility could not be determined');
        return Response.json(
          { code: 'workspace_eligibility_unknown', error: WORKSPACE_ELIGIBILITY_UNKNOWN_MESSAGE },
          { status: 503, headers: { 'Cache-Control': 'private, no-store' } },
        );
      }
      console.error('User-owned Cloudflare workspace runtime provisioning failed');
      const planRequired =
        error instanceof UserWorkspaceContainersPlanRequiredError || isWorkspacePlanRequiredError(error);
      const upgradeUrl = error instanceof UserWorkspaceContainersPlanRequiredError ? error.upgradeUrl : null;
      const body: WorkspacePreparationFailure = {
        code: planRequired ? 'workspace_plan_required' : 'workspace_preparation_failed',
        error: planRequired ? WORKSPACE_PLAN_REQUIRED_MESSAGE : WORKSPACE_PREPARATION_FAILED_MESSAGE,
      };
      if (planRequired && upgradeUrl) {
        body.upgradeUrl = upgradeUrl;
      }
      return Response.json(body, { status: 502, headers: { 'Cache-Control': 'private, no-store' } });
    }
  }
  const [currentConnection, currentRuntime] = await Promise.all([
    findCloudflareConnectionForUser(env.DB, session.user.id),
    findUserWorkspaceRuntime(env.DB, session.user.id),
  ]);
  // "The account changed" and "the workspace is not ready yet" are different answers and only one
  // of them is the user's problem. Collapsing both into the former told a user whose provisioning
  // attempt was simply still in flight that their Cloudflare account had changed, and the browser
  // treats that as final — so it stopped polling and sat on a dead end until the lease expired.
  if (!currentConnection || currentConnection.status !== 'active') {
    return Response.json(
      { error: 'The Cloudflare account changed while Ghostbuild prepared the workspace. Try again.' },
      { status: 409, headers: { 'Cache-Control': 'private, no-store' } },
    );
  }
  // A runtime belonging to a different connection or generation is the one genuine account change:
  // the workspace no longer belongs to the account this session would be minted for. Read before
  // the guard below, whose type predicate narrows the failing branch to `null` even though a
  // not-yet-ready runtime is a perfectly real row.
  const runtimeBelongsToAnotherAccount =
    currentRuntime !== null &&
    (currentRuntime.connectionId !== currentConnection.id ||
      currentRuntime.connectionGeneration !== currentConnection.generation);
  if (!isUsableWorkspaceRuntime(currentRuntime, currentConnection, upgradeDeferred)) {
    if (runtimeBelongsToAnotherAccount) {
      return Response.json(
        { error: 'The Cloudflare account changed while Ghostbuild prepared the workspace. Try again.' },
        { status: 409, headers: { 'Cache-Control': 'private, no-store' } },
      );
    }
    return Response.json(
      { code: 'workspace_preparing', error: 'Ghostbuild is still preparing your workspace.' },
      { status: 409, headers: { 'Cache-Control': 'private, no-store' } },
    );
  }
  const secret = await deriveUserWorkspaceRuntimeSecret({
    encryptionKeyBase64: env.CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY,
    userId: session.user.id,
    accountId: currentConnection.accountId,
    connectionGeneration: currentConnection.generation,
  });
  // The control plane owns the browser/server join key. Minting it here and
  // logging it beside this grant lets an incident responder line up opted-in
  // browser funnel events with the request that issued the runtime session,
  // without the browser's journey ID ever reaching the server as an identifier.
  const correlationId = crypto.randomUUID();
  console.info({
    event: 'runtime_session_issued',
    correlationId,
    connectionGeneration: currentConnection.generation,
    runtimeVersion: currentRuntime.runtimeVersion,
  });
  const [capability, aiGatewayCreditStatus] = await Promise.all([
    mintRuntimeCapability({
      secret,
      subject: session.user.id,
      origin: new URL(request.url).origin,
    }),
    readAiGatewayCreditStatusWithTimeout(
      (readAiGatewayCreditStatus ?? getAiGatewayCreditStatus)({
        env,
        connection: currentConnection,
      }),
    ),
  ]);
  return Response.json(
    { endpoint: currentRuntime.endpoint, ...capability, aiGatewayCreditStatus, correlationId },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}

async function readAiGatewayCreditStatusWithTimeout(
  operation: Promise<AiGatewayCreditStatus>,
): Promise<AiGatewayCreditStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<AiGatewayCreditStatus>((resolve) => {
    timer = setTimeout(() => resolve('unknown'), AI_GATEWAY_CREDIT_CHECK_TIMEOUT_MS);
  });
  try {
    return await Promise.race([operation.catch(() => 'unknown' as const), timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function getAiGatewayCreditStatus({
  env,
  connection,
}: {
  env: Env;
  connection: CloudflareConnection;
}): Promise<AiGatewayCreditStatus> {
  if (!connection.credentialHandle) {
    return 'unknown';
  }
  try {
    const signal = AbortSignal.timeout(AI_GATEWAY_CREDIT_CHECK_TIMEOUT_MS);
    const accessToken = await D1CloudflareCredentialVault.fromEnv(env).resolve(connection.credentialHandle);
    const balance = await new UserCloudflareAccountApi(connection.accountId, accessToken).getAiGatewayCreditBalance(
      signal,
    );
    return balance > 0 ? 'available' : 'unavailable';
  } catch {
    console.warn('Unable to check AI Gateway Unified Billing credit availability.');
    return 'unknown';
  }
}

type ReadAiGatewayCreditStatus = (args: {
  env: Env;
  connection: CloudflareConnection;
}) => Promise<AiGatewayCreditStatus>;

/** A plan refusal Cloudflare raised somewhere other than the precondition check still has to be named. */
function isWorkspacePlanRequiredError(error: unknown): boolean {
  return isWorkspacePlanRequiredMessage(error instanceof Error ? error.message : String(error));
}

function isCurrentWorkspaceRuntime(
  runtime: UserWorkspaceRuntime | null,
  connection: CloudflareConnection,
): runtime is UserWorkspaceRuntime {
  return isUsableWorkspaceRuntime(runtime, connection, false);
}

/**
 * A runtime this request may serve. Only the runtime *version* is ever allowed to lag, and only
 * for a deferred upgrade: a changed connection or generation would mean the workspace no longer
 * belongs to the Cloudflare account this session is being minted for.
 *
 * The container image is part of the same staleness answer so it converges the way the runtime
 * version already does. Without it, an account whose image copy failed once — a registry blip, a
 * credential mint that did not land — stayed on the stock base image forever, because nothing
 * downstream ever reconsidered it; and a rebuilt image never reached anyone already provisioned. A
 * row predating the column reads as `null`, which is correctly unequal and converges on the next
 * session.
 */
function isUsableWorkspaceRuntime(
  runtime: UserWorkspaceRuntime | null,
  connection: CloudflareConnection,
  upgradeDeferred: boolean,
): runtime is UserWorkspaceRuntime {
  return (
    runtime?.status === 'ready' &&
    runtime.connectionId === connection.id &&
    runtime.connectionGeneration === connection.generation &&
    ((runtime.runtimeVersion === USER_WORKSPACE_RUNTIME_SHA256 &&
      runtime.imageDigest === cloudflareWorkspaceImageReferenceOrNull(connection.accountId)) ||
      upgradeDeferred)
  );
}

/**
 * Decide whether to leave a stale-but-working runtime alone for now.
 *
 * The busy signal comes from the workspace itself, over the control-plane-authenticated channel the
 * provisioner already uses. That costs one request, and only on the runtime-session requests that
 * follow a release; nothing cheaper is available, because the lane the answer depends on lives in
 * the per-project Durable Objects inside the user's own Worker.
 *
 * An activity answer that could not be read defers too. Provisioning on an unreadable answer would
 * turn "could not observe" into "assumed idle", which is exactly the interruption being fixed; the
 * staleness bound is what keeps that safe. A runtime that cannot be asked at all - one that
 * predates the route, or refuses the control-plane secret - is a definite "cannot report" and
 * upgrades immediately, because the upgrade is what makes it answerable.
 */
async function deferRuntimeUpgradeWhileWorkspaceIsBusy(args: {
  env: Env;
  userId: string;
  runtime: UserWorkspaceRuntime | null;
  connection: CloudflareConnection;
  readWorkspaceActivity: typeof readUserWorkspaceRuntimeActivity;
}): Promise<boolean> {
  const { runtime, connection } = args;
  if (
    !runtime ||
    runtime.status !== 'ready' ||
    runtime.connectionId !== connection.id ||
    runtime.connectionGeneration !== connection.generation ||
    !args.env.CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY
  ) {
    return false;
  }
  const now = Date.now();
  const deferredForMs = now - (runtime.upgradeDeferredSince ?? now);
  if (deferredForMs >= MAX_RUNTIME_UPGRADE_DEFERRAL_MS) {
    console.info({ event: 'runtime_upgrade_forced', deferredForMs });
    return false;
  }
  const activity = await args.readWorkspaceActivity({
    endpoint: runtime.endpoint,
    controlPlaneSecret: await deriveUserWorkspaceRuntimeSecret({
      encryptionKeyBase64: args.env.CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY,
      userId: args.userId,
      accountId: connection.accountId,
      connectionGeneration: connection.generation,
    }),
  });
  if (activity === 'idle' || activity === 'unreported') {
    return false;
  }
  const deferredSince = await recordUserWorkspaceRuntimeUpgradeDeferral({
    db: args.env.DB,
    userId: args.userId,
    runtimeVersion: runtime.runtimeVersion,
    now,
  });
  console.info({
    event: 'runtime_upgrade_deferred',
    reason: activity === 'busy' ? 'workspace_busy' : 'activity_unknown',
    deferredForMs: now - deferredSince,
  });
  return true;
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
    const { state, callbackUrl, providerRejectedAuthorization } = await readCloudflareCallback(args.request);
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
    if (providerRejectedAuthorization) {
      await failOAuthState({ db: args.env.DB, stateId: state, expected: oauthState });
      return cloudflareAuthorizationRecoveryResponse(args.request, oauthState.return_to);
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
          grantedCapabilities: result.grantedCapabilities,
          requestedOAuthScopes: result.requestedOAuthScopes,
          grantedOAuthScopes: result.grantedOAuthScopes,
          oauthScopeProfileVersion: result.oauthScopeProfileVersion,
          oauthScopeGrantStatus: result.oauthScopeGrantStatus,
          aiBillingEnabled: result.grantedCapabilities.includes('workers_ai'),
          expectedGeneration: previous?.generation ?? null,
        });
      } catch (error) {
        const racedConnection =
          error instanceof CloudflareConnectionChangedError
            ? await findCloudflareConnectionForUser(args.env.DB, userId).catch((readError) => {
                console.warn('Unable to read raced Cloudflare connection', readError);
                return null;
              })
            : null;
        const canAdoptRace =
          racedConnection && isEquivalentRacedConnection(racedConnection, userId, result, previous?.generation ?? null);
        await vault.deleteIfUnreferenced(credentialHandle).catch((cleanupError) => {
          console.warn('Unable to clean up orphaned Cloudflare credential', cleanupError);
        });
        if (!canAdoptRace) {
          throw error;
        }
      }
      if (previous?.credentialHandle && previous.credentialHandle !== credentialHandle) {
        await vault.deleteIfUnreferenced(previous.credentialHandle).catch((cleanupError) => {
          console.warn('Unable to clean up previous Cloudflare credential', cleanupError);
        });
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
    sameStringArray(connection.grantedCapabilities, result.grantedCapabilities) &&
    sameStringArray(connection.requestedOAuthScopes, result.requestedOAuthScopes) &&
    sameStringArray(connection.grantedOAuthScopes, result.grantedOAuthScopes) &&
    connection.oauthScopeProfileVersion === result.oauthScopeProfileVersion &&
    connection.oauthScopeGrantStatus === result.oauthScopeGrantStatus
  );
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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
    if (
      await isExactOAuthState(args.db, args.stateId, args.expected, 'pending', args.userId, updatedAt).catch(
        (readError) => {
          console.warn('Unable to verify OAuth checkpoint state', readError);
          return false;
        },
      )
    ) {
      return;
    }
    throw error;
  }
  if (await isExactOAuthState(args.db, args.stateId, args.expected, 'pending', args.userId, updatedAt)) {
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
      await isExactOAuthState(args.db, args.stateId, args.expected, 'completed', args.userId, updatedAt).catch(
        (readError) => {
          console.warn('Unable to verify OAuth completion state', readError);
          return false;
        },
      )
    ) {
      return;
    }
    throw error;
  }
  if (await isExactOAuthState(args.db, args.stateId, args.expected, 'completed', args.userId, updatedAt)) {
    return;
  }
  throw new Error('Cloudflare authorization state changed while completion was being persisted.');
}

async function failOAuthState(args: { db: D1Database; stateId: string; expected: PendingOAuthState }): Promise<void> {
  const updatedAt = Date.now();
  try {
    const result = await args.db
      .prepare(
        `UPDATE cloudflare_oauth_states SET status = 'error', updated_at = ?
         WHERE id = ? AND status = 'pending' AND provider_session_id = ? AND return_to = ?
           AND expires_at = ? AND authenticated_user_id IS ?`,
      )
      .bind(
        updatedAt,
        args.stateId,
        args.expected.provider_session_id,
        args.expected.return_to,
        args.expected.expires_at,
        args.expected.authenticated_user_id,
      )
      .run();
    if (result.meta.changes === 1) {
      return;
    }
  } catch (error) {
    if (
      await isExactOAuthState(
        args.db,
        args.stateId,
        args.expected,
        'error',
        args.expected.authenticated_user_id,
        updatedAt,
      ).catch((readError) => {
        console.warn('Unable to verify OAuth error state', readError);
        return false;
      })
    ) {
      return;
    }
    throw error;
  }
  if (
    await isExactOAuthState(
      args.db,
      args.stateId,
      args.expected,
      'error',
      args.expected.authenticated_user_id,
      updatedAt,
    )
  ) {
    return;
  }
  throw new Error('Cloudflare authorization state changed while the provider error was being persisted.');
}

async function isExactOAuthState(
  db: D1Database,
  stateId: string,
  expected: PendingOAuthState,
  status: 'pending' | 'completed' | 'error',
  authenticatedUserId: string | null,
  updatedAt: number,
): Promise<boolean> {
  const row = await readOAuthState(db, stateId);
  if (!row) {
    return false;
  }
  return (
    row.provider_session_id === expected.provider_session_id &&
    row.return_to === expected.return_to &&
    row.status === status &&
    row.expires_at === expected.expires_at &&
    row.authenticated_user_id === authenticatedUserId &&
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

async function readCloudflareCallback(
  request: Request,
): Promise<{ state: string; callbackUrl: string; providerRejectedAuthorization: boolean }> {
  const requestUrl = new URL(request.url);
  const payload = parseIntegrationRequest(callbackPayloadSchema, Object.fromEntries(requestUrl.searchParams));
  const callbackUrl = new URL(requestUrl.pathname, requestUrl.origin);
  for (const key of ['state', 'code', 'error', 'error_description', 'scope'] as const) {
    const value = payload[key];
    if (value) {
      callbackUrl.searchParams.set(key, value);
    }
  }
  return {
    state: payload.state,
    callbackUrl: callbackUrl.toString(),
    providerRejectedAuthorization: Boolean(payload.error),
  };
}

function cloudflareAuthorizationRecoveryResponse(request: Request, returnTo: string): Response {
  const requestUrl = new URL(request.url);
  const continuation = safeReturnTo(returnTo, requestUrl.origin);
  const originalTarget = new URL(continuation, requestUrl.origin);
  const recoveryTarget =
    originalTarget.pathname === '/settings' ? originalTarget : new URL('/settings', requestUrl.origin);
  if (originalTarget.pathname !== '/settings') {
    recoveryTarget.searchParams.set('continue', continuation);
  }
  recoveryTarget.searchParams.set(CLOUDFLARE_AUTHORIZATION_ERROR_PARAM, CLOUDFLARE_AUTHORIZATION_ERROR_VALUE);
  recoveryTarget.hash = 'cloudflare';
  return new Response(null, {
    status: 303,
    headers: {
      Location: recoveryTarget.toString(),
      'Set-Cookie': oauthStateCookie('', 0, request),
    },
  });
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
  console.error('Cloudflare authorization failed');
  return Response.json({ error: 'Cloudflare authorization failed.' }, { status: 500 });
}
