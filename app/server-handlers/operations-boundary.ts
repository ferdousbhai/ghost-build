import { getAuthSession } from '~/lib/.server/auth';
import { provisionUserWorkspaceRuntime } from '~/lib/.server/cloudflare/user-workspace-runtime-provisioner';
import { USER_WORKSPACE_RUNTIME_SHA256 } from '~/generated/user-workspace-runtime.generated';
import { InvalidJsonBodyError, PayloadTooLargeError, readJsonBodyWithLimit } from '~/lib/bounded-body';

const MAX_RECONCILE_REQUEST_BYTES = 1_024;
const OPS_SESSION_TTL_MS = 15 * 60_000;
const OPS_AUDIENCE = 'admin.ghostbuild.dev';

export async function operationsSessionAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  const session = await getAuthSession(env, request);
  if (
    !session ||
    !env.GHOSTBUILD_ADMIN_EMAIL ||
    session.user.email.toLowerCase() !== env.GHOSTBUILD_ADMIN_EMAIL.toLowerCase()
  ) {
    return Response.json({ error: 'Not found' }, { status: 404, headers: noStoreHeaders() });
  }
  const payload = base64UrlEncode(
    new TextEncoder().encode(
      JSON.stringify({
        sub: session.user.id,
        email: session.user.email,
        exp: Date.now() + OPS_SESSION_TTL_MS,
        aud: OPS_AUDIENCE,
      }),
    ),
  );
  const signature = await sign(payload, await env.OPS_AUTH_SECRET.get());
  return new Response(null, {
    status: 302,
    headers: {
      ...noStoreHeaders(),
      Location: 'https://admin.ghostbuild.dev/',
      'Set-Cookie': `ghostbuild_ops_session=${payload}.${signature}; Domain=.ghostbuild.dev; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=900`,
    },
  });
}

export async function operationsRuntimeVersionAction({
  request,
  env,
}: {
  request: Request;
  env: Env;
}): Promise<Response> {
  if (!(await isOperationsService(request, env))) {
    return Response.json({ error: 'Not found' }, { status: 404, headers: noStoreHeaders() });
  }
  return Response.json({ runtimeVersion: USER_WORKSPACE_RUNTIME_SHA256 }, { headers: noStoreHeaders() });
}

export async function operationsReconcileRuntimeAction({
  request,
  env,
}: {
  request: Request;
  env: Env;
}): Promise<Response> {
  if (!(await isOperationsService(request, env))) {
    return Response.json({ error: 'Not found' }, { status: 404, headers: noStoreHeaders() });
  }
  let payload: { userId?: unknown } | null;
  try {
    const value = await readJsonBodyWithLimit(request, MAX_RECONCILE_REQUEST_BYTES, 'Operations runtime request');
    payload = value && typeof value === 'object' && !Array.isArray(value) ? (value as { userId?: unknown }) : null;
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return Response.json({ error: error.message }, { status: 413, headers: noStoreHeaders() });
    }
    if (error instanceof InvalidJsonBodyError) {
      return Response.json({ error: error.message }, { status: 400, headers: noStoreHeaders() });
    }
    throw error;
  }
  if (!payload || typeof payload.userId !== 'string' || payload.userId.length === 0 || payload.userId.length > 128) {
    return Response.json({ error: 'Invalid user.' }, { status: 400, headers: noStoreHeaders() });
  }
  const connection = await env.DB.prepare(
    `SELECT id FROM cloudflare_connections WHERE user_id = ? AND status = 'active'`,
  )
    .bind(payload.userId)
    .first<{ id: string }>();
  if (!connection) {
    return Response.json({ error: 'Active connection not found.' }, { status: 404, headers: noStoreHeaders() });
  }
  try {
    const runtime = await provisionUserWorkspaceRuntime({
      env,
      userId: payload.userId,
      connectionId: connection.id,
    });
    return Response.json(
      { status: runtime.status, runtimeVersion: runtime.runtimeVersion },
      { headers: noStoreHeaders() },
    );
  } catch {
    console.error('Operations workspace runtime reconciliation failed');
    return Response.json(
      { error: 'Workspace runtime upgrade failed. Refresh to review the stored runtime status.' },
      { status: 502, headers: noStoreHeaders() },
    );
  }
}

async function isOperationsService(request: Request, env: Env): Promise<boolean> {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ') || authorization.length > 4_103) {
    return false;
  }
  const supplied = authorization.slice(7);
  const expected = await env.OPS_AUTH_SECRET.get();
  if (supplied.length < 32 || expected.length < 32 || supplied.length > 4_096 || expected.length > 4_096) {
    return false;
  }
  const [suppliedHash, expectedHash] = await Promise.all([sha256(supplied), sha256(expected)]);
  let different = 0;
  for (let index = 0; index < suppliedHash.length; index++) {
    different |= suppliedHash[index]! ^ expectedHash[index]!;
  }
  return different === 0;
}

async function sign(payload: string, secret: string): Promise<string> {
  if (secret.length < 32 || secret.length > 4_096) {
    throw new Error('Operations authentication is not configured.');
  }
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return base64UrlEncode(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))));
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

function base64UrlEncode(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function noStoreHeaders(): HeadersInit {
  return { 'Cache-Control': 'private, no-store' };
}
