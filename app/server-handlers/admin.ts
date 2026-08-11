import { getAuthSession } from '~/lib/.server/auth';
import { provisionUserWorkspaceRuntime } from '~/lib/.server/cloudflare/user-workspace-runtime-provisioner';
import { USER_WORKSPACE_RUNTIME_SHA256 } from '~/generated/user-workspace-runtime.generated';
import { InvalidJsonBodyError, PayloadTooLargeError, readJsonBodyWithLimit } from '~/lib/bounded-body';

const MAX_ADMIN_RUNTIME_REQUEST_BYTES = 1_024;

type CountRow = { count: number };
type RuntimeRow = {
  user_id: string;
  email: string;
  connection_id: string;
  status: string | null;
  runtime_version: string | null;
  last_error: string | null;
  updated_at: number | null;
};

export async function adminOverviewAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  if (!(await isAdmin(request, env))) {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }
  const now = Date.now();
  const week = 7 * 24 * 60 * 60 * 1_000;
  const [users, newThisWeek, newPreviousWeek, activeConnections, sessions, runtimeRows, monitorRows] =
    await Promise.all([
      count(env.DB, 'SELECT COUNT(*) AS count FROM "user"'),
      count(env.DB, 'SELECT COUNT(*) AS count FROM "user" WHERE createdAt >= ?', now - week),
      count(
        env.DB,
        'SELECT COUNT(*) AS count FROM "user" WHERE createdAt >= ? AND createdAt < ?',
        now - 2 * week,
        now - week,
      ),
      count(env.DB, "SELECT COUNT(*) AS count FROM cloudflare_connections WHERE status = 'active'"),
      count(env.DB, 'SELECT COUNT(*) AS count FROM cloudflare_auth_sessions WHERE expires_at > ?', now),
      env.DB.prepare(
        `SELECT users.id AS user_id, users.email, connections.id AS connection_id,
                runtimes.status, runtimes.runtime_version, runtimes.last_error, runtimes.updated_at
         FROM "user" AS users
         JOIN cloudflare_connections AS connections ON connections.user_id = users.id
         LEFT JOIN user_computer_runtimes AS runtimes ON runtimes.user_id = users.id
         WHERE connections.status = 'active'
         ORDER BY users.createdAt
         LIMIT 100`,
      ).all<RuntimeRow>(),
      env.DB.prepare(
        `SELECT id, status, started_at, completed_at, summary_json, error
         FROM upstream_monitor_runs ORDER BY completed_at DESC LIMIT 12`,
      ).all(),
    ]);
  return Response.json(
    {
      generatedAt: now,
      currentRuntimeVersion: USER_WORKSPACE_RUNTIME_SHA256,
      metrics: { users, newThisWeek, newPreviousWeek, activeConnections, sessions },
      runtimes: runtimeRows.results.map((row) => ({
        ...row,
        current: row.status === 'ready' && row.runtime_version === USER_WORKSPACE_RUNTIME_SHA256,
      })),
      upstreamRuns: monitorRows.results,
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}

export async function adminReconcileRuntimeAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  if (!sameOrigin(request) || !(await isAdmin(request, env))) {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }
  let payload: { userId?: unknown } | null;
  try {
    const value = await readJsonBodyWithLimit(request, MAX_ADMIN_RUNTIME_REQUEST_BYTES, 'Admin runtime request');
    payload = value && typeof value === 'object' && !Array.isArray(value) ? (value as { userId?: unknown }) : null;
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return Response.json({ error: error.message }, { status: 413 });
    }
    if (error instanceof InvalidJsonBodyError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
  if (!payload || typeof payload.userId !== 'string' || payload.userId.length > 128) {
    return Response.json({ error: 'Invalid user.' }, { status: 400 });
  }
  const connection = await env.DB.prepare(
    `SELECT id FROM cloudflare_connections WHERE user_id = ? AND status = 'active'`,
  )
    .bind(payload.userId)
    .first<{ id: string }>();
  if (!connection) {
    return Response.json({ error: 'Active connection not found.' }, { status: 404 });
  }
  try {
    const runtime = await provisionUserWorkspaceRuntime({
      env,
      userId: payload.userId,
      connectionId: connection.id,
    });
    return Response.json({ status: runtime.status, runtimeVersion: runtime.runtimeVersion });
  } catch {
    console.error('Admin workspace runtime reconciliation failed');
    return Response.json(
      { error: 'Workspace runtime upgrade failed. Refresh to review the stored runtime status.' },
      { status: 502 },
    );
  }
}

async function isAdmin(request: Request, env: Env): Promise<boolean> {
  const session = await getAuthSession(env, request);
  return Boolean(
    session &&
    env.GHOSTBUILD_ADMIN_EMAIL &&
    session.user.email.toLowerCase() === env.GHOSTBUILD_ADMIN_EMAIL.toLowerCase(),
  );
}

async function count(db: D1Database, sql: string, ...values: unknown[]): Promise<number> {
  const row = await db
    .prepare(sql)
    .bind(...values)
    .first<CountRow>();
  return row?.count ?? 0;
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  return Boolean(origin && origin === new URL(request.url).origin);
}
