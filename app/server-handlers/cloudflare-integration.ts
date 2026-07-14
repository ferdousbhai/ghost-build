import { z } from 'zod';
import { getAuth } from '~/lib/.server/auth';
import {
  activateCloudflareConnection,
  findCloudflareConnectionForUser,
} from '~/lib/.server/cloudflare/cloudflare-connection-repository';
import { D1CloudflareCredentialVault } from '~/lib/.server/cloudflare/cloudflare-credential-vault';
import {
  CloudflareOrchestratorUnavailableError,
  createCloudflareOrchestrator,
  type CloudflareOrchestrator,
} from '~/lib/.server/cloudflare/cloudflare-orchestrator';

const requestedCapabilities = ['workers', 'd1', 'r2', 'durable_objects', 'workers_ai'] as const;
const callbackQuerySchema = z.object({ state: z.string().uuid() });
const challengeSchema = z.object({
  sessionId: z.string().min(1),
  authorizationUrl: z
    .string()
    .url()
    .refine((value) => new URL(value).protocol === 'https:', 'HTTPS is required'),
  expiresAt: z.number().int().positive(),
});
const connectionResultSchema = z.object({
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
  const session = await getAuth(env, request).api.getSession({ headers: request.headers });
  if (!session) {
    return Response.json({ error: 'Authentication required.' }, { status: 401 });
  }

  const connection = await findCloudflareConnectionForUser(env.DB, session.user.id);
  if (!connection) {
    return Response.json({ connected: false, status: null, aiBillingEnabled: false });
  }

  return Response.json({
    connected: connection.status === 'active',
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
    const session = await getAuth(args.env, args.request).api.getSession({ headers: args.request.headers });
    if (!session) {
      return Response.json({ error: 'Authentication required.' }, { status: 401 });
    }
    const current = await findCloudflareConnectionForUser(args.env.DB, session.user.id);
    if (current?.status === 'active') {
      return Response.json({ error: 'Cloudflare is already connected.' }, { status: 409 });
    }

    const state = crypto.randomUUID();
    const requestUrl = new URL(args.request.url);
    const returnUrl = new URL('/api/cloudflare/connection/callback', requestUrl.origin);
    returnUrl.searchParams.set('state', state);
    const orchestrator = args.orchestrator ?? (await createCloudflareOrchestrator(args.env));
    const challenge = challengeSchema.parse(
      await orchestrator.startConnection({
        userId: session.user.id,
        userEmail: session.user.email,
        returnUrl: returnUrl.toString(),
        requestedCapabilities: [...requestedCapabilities],
      }),
    );
    const now = Date.now();
    if (challenge.expiresAt <= now) {
      throw new Error('Cloudflare returned an expired authorization challenge.');
    }
    await args.env.DB.prepare(
      `INSERT INTO cloudflare_connection_sessions
        (id, user_id, provider_session_id, status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
    )
      .bind(state, session.user.id, challenge.sessionId, challenge.expiresAt, now, now)
      .run();
    return Response.json(
      { authorizationUrl: challenge.authorizationUrl, expiresAt: challenge.expiresAt },
      { status: 201 },
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
    const session = await getAuth(args.env, args.request).api.getSession({ headers: args.request.headers });
    if (!session) {
      return Response.json({ error: 'Authentication required.' }, { status: 401 });
    }
    const { state } = callbackQuerySchema.parse(Object.fromEntries(new URL(args.request.url).searchParams));
    const connectionSession = await args.env.DB.prepare(
      `SELECT provider_session_id, expires_at
       FROM cloudflare_connection_sessions
       WHERE id = ? AND user_id = ? AND status = 'pending'`,
    )
      .bind(state, session.user.id)
      .first<{ provider_session_id: string; expires_at: number }>();
    if (!connectionSession) {
      return Response.json({ error: 'Cloudflare connection session not found.' }, { status: 404 });
    }
    if (connectionSession.expires_at <= Date.now()) {
      await args.env.DB.prepare(
        `UPDATE cloudflare_connection_sessions SET status = 'expired', updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
        .bind(Date.now(), state)
        .run();
      return Response.json({ error: 'Cloudflare connection session expired.' }, { status: 410 });
    }
    if (!args.env.CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY) {
      throw new Error('Cloudflare credential encryption is not configured.');
    }

    const orchestrator = args.orchestrator ?? (await createCloudflareOrchestrator(args.env));
    const result = connectionResultSchema.parse(
      await orchestrator.completeConnection({
        providerSessionId: connectionSession.provider_session_id,
        callbackUrl: args.request.url,
      }),
    );
    const previous = await findCloudflareConnectionForUser(args.env.DB, session.user.id);
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
        userId: session.user.id,
        accountId: result.accountId,
        accountName: result.accountName,
        credentialHandle,
        grantedScopes: result.grantedCapabilities,
        aiBillingEnabled: result.grantedCapabilities.includes('workers_ai'),
      });
      await args.env.DB.prepare(
        `UPDATE cloudflare_connection_sessions SET status = 'completed', updated_at = ?
         WHERE id = ? AND user_id = ? AND status = 'pending'`,
      )
        .bind(Date.now(), state, session.user.id)
        .run();
    } catch (error) {
      await vault.delete(credentialHandle).catch(() => undefined);
      throw error;
    }
    if (previous?.credentialHandle && previous.credentialHandle !== credentialHandle) {
      await vault.delete(previous.credentialHandle).catch(() => undefined);
    }
    return Response.redirect(new URL('/settings?cloudflare=connected', args.request.url), 303);
  } catch (error) {
    return cloudflareIntegrationErrorResponse(error);
  }
}

function cloudflareIntegrationErrorResponse(error: unknown): Response {
  if (error instanceof CloudflareOrchestratorUnavailableError) {
    return Response.json({ error: 'Cloudflare OAuth is not configured for this environment.' }, { status: 503 });
  }
  if (error instanceof z.ZodError) {
    return Response.json({ error: 'Invalid Cloudflare connection response.' }, { status: 502 });
  }
  console.error('Cloudflare connection failed', error);
  return Response.json(
    { error: error instanceof Error ? error.message : 'Cloudflare connection failed.' },
    { status: 500 },
  );
}
