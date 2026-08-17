import { beforeEach, describe, expect, it, vi } from 'vitest';

const provisionUserWorkspaceRuntime = vi.hoisted(() => vi.fn());
const findCloudflareConnectionForUser = vi.hoisted(() => vi.fn());

vi.mock('~/lib/.server/cloudflare/user-workspace-runtime-provisioner', () => ({ provisionUserWorkspaceRuntime }));
vi.mock('~/lib/.server/cloudflare/cloudflare-connection-repository', () => ({ findCloudflareConnectionForUser }));

import { OperationsService } from './operations-service';

describe('private operations control-plane entrypoint', () => {
  beforeEach(() => {
    provisionUserWorkspaceRuntime.mockReset().mockResolvedValue({ status: 'ready', runtimeVersion: 'a'.repeat(64) });
    findCloudflareConnectionForUser.mockReset().mockResolvedValue({ id: 'connection-1', status: 'active' });
  });

  it('reports the runtime version the control plane expects workspaces to run', async () => {
    await expect(service(env()).runtimeVersion()).resolves.toMatch(/^[a-f0-9]{64}$/);
  });

  it('reconciles a user that has an active connection', async () => {
    const runtimeEnv = env();

    await expect(service(runtimeEnv).reconcileRuntime('user-1')).resolves.toEqual({
      ok: true,
      status: 'ready',
      runtimeVersion: 'a'.repeat(64),
    });
    expect(provisionUserWorkspaceRuntime).toHaveBeenCalledWith({
      env: runtimeEnv,
      userId: 'user-1',
      connectionId: 'connection-1',
    });
  });

  it.each([
    { userId: '', reason: 'invalid-user' },
    { userId: 'u'.repeat(129), reason: 'invalid-user' },
  ])('rejects an out-of-bounds user id without touching the database: %o', async ({ userId, reason }) => {
    await expect(service(env()).reconcileRuntime(userId)).resolves.toEqual({ ok: false, reason });
    expect(findCloudflareConnectionForUser).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'no connection row', connection: null },
    { label: 'a revoked connection', connection: { id: 'connection-1', status: 'revoked' } },
  ])('treats $label as a missing active connection', async ({ connection }) => {
    findCloudflareConnectionForUser.mockResolvedValue(connection);

    await expect(service(env()).reconcileRuntime('user-1')).resolves.toEqual({
      ok: false,
      reason: 'connection-not-found',
    });
    expect(provisionUserWorkspaceRuntime).not.toHaveBeenCalled();
  });

  it('reports a provisioning failure separately from a missing connection', async () => {
    provisionUserWorkspaceRuntime.mockRejectedValue(new Error('upstream refused'));

    await expect(service(env()).reconcileRuntime('user-1')).resolves.toEqual({
      ok: false,
      reason: 'provisioning-failed',
    });
  });
});

function service(runtimeEnv: Env): OperationsService {
  return new OperationsService({} as ExecutionContext, runtimeEnv);
}

function env(overrides: Partial<Env> = {}): Env {
  return { ...overrides } as Env;
}
