import { beforeEach, describe, expect, it, vi } from 'vitest';

const getAuthSession = vi.hoisted(() => vi.fn());
const provisionUserWorkspaceRuntime = vi.hoisted(() => vi.fn());

vi.mock('~/lib/.server/auth', () => ({ getAuthSession }));
vi.mock('~/lib/.server/cloudflare/user-workspace-runtime-provisioner', () => ({
  provisionUserWorkspaceRuntime,
}));

import { adminOverviewAction, adminReconcileRuntimeAction } from './admin';

describe('owner operations boundary', () => {
  beforeEach(() => {
    getAuthSession.mockReset();
    provisionUserWorkspaceRuntime.mockReset();
  });

  it('returns a non-enumerable 404 before reading operational data for another user', async () => {
    getAuthSession.mockResolvedValue({ user: { email: 'someone@example.com' } });
    const prepare = vi.fn();

    const response = await adminOverviewAction({
      request: new Request('https://ghostbuild.dev/api/admin/overview'),
      env: { DB: { prepare }, GHOSTBUILD_ADMIN_EMAIL: 'ferdousbd@gmail.com' } as unknown as Env,
    });

    expect(response.status).toBe(404);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('returns bounded aggregate metrics and runtime status to the configured owner', async () => {
    getAuthSession.mockResolvedValue({ user: { email: 'FERDOUSBD@gmail.com' } });
    const env = overviewEnv();

    const response = await adminOverviewAction({
      request: new Request('https://ghostbuild.dev/api/admin/overview'),
      env,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      metrics: { users: 2, newThisWeek: 1, newPreviousWeek: 0, activeConnections: 2, sessions: 1 },
      runtimes: [{ email: 'owner@example.com', current: false }],
      upstreamRuns: [{ status: 'ok' }],
    });
  });

  it('requires same-origin owner authorization before reconciling a runtime', async () => {
    getAuthSession.mockResolvedValue({ user: { email: 'ferdousbd@gmail.com' } });
    const response = await adminReconcileRuntimeAction({
      request: new Request('https://ghostbuild.dev/api/admin/runtimes/reconcile', {
        method: 'POST',
        headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'user-1' }),
      }),
      env: { GHOSTBUILD_ADMIN_EMAIL: 'ferdousbd@gmail.com' } as Env,
    });

    expect(response.status).toBe(404);
    expect(getAuthSession).not.toHaveBeenCalled();
    expect(provisionUserWorkspaceRuntime).not.toHaveBeenCalled();
  });

  it('upgrades only the requested active user runtime and returns no credentials', async () => {
    getAuthSession.mockResolvedValue({ user: { email: 'ferdousbd@gmail.com' } });
    provisionUserWorkspaceRuntime.mockResolvedValue({ status: 'ready', runtimeVersion: 'a'.repeat(64) });
    const first = vi.fn().mockResolvedValue({ id: 'connection-1' });
    const env = {
      GHOSTBUILD_ADMIN_EMAIL: 'ferdousbd@gmail.com',
      DB: { prepare: vi.fn(() => ({ bind: () => ({ first }) })) },
    } as unknown as Env;
    const response = await adminReconcileRuntimeAction({
      request: new Request('https://ghostbuild.dev/api/admin/runtimes/reconcile', {
        method: 'POST',
        headers: { Origin: 'https://ghostbuild.dev', 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'user-1' }),
      }),
      env,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ready', runtimeVersion: 'a'.repeat(64) });
    expect(provisionUserWorkspaceRuntime).toHaveBeenCalledWith({
      env,
      userId: 'user-1',
      connectionId: 'connection-1',
    });
  });
});

function overviewEnv(): Env {
  let countIndex = 0;
  const counts = [2, 1, 0, 2, 1];
  const prepare = vi.fn((sql: string) => ({
    bind: () => ({ first: async () => ({ count: counts[countIndex++] }) }),
    first: async () => ({ count: counts[countIndex++] }),
    all: async () =>
      sql.includes('user_computer_runtimes')
        ? {
            results: [
              {
                user_id: 'user-1',
                email: 'owner@example.com',
                connection_id: 'connection-1',
                status: 'error',
                runtime_version: 'old',
                last_error: 'plan required',
                updated_at: 1,
              },
            ],
          }
        : {
            results: [
              {
                id: 'run-1',
                status: 'ok',
                started_at: 1,
                completed_at: 2,
                summary_json: null,
                error: null,
              },
            ],
          },
  }));
  return { DB: { prepare }, GHOSTBUILD_ADMIN_EMAIL: 'ferdousbd@gmail.com' } as unknown as Env;
}
