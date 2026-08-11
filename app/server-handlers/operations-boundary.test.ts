import { beforeEach, describe, expect, it, vi } from 'vitest';

const getAuthSession = vi.hoisted(() => vi.fn());
const provisionUserWorkspaceRuntime = vi.hoisted(() => vi.fn());

vi.mock('~/lib/.server/auth', () => ({ getAuthSession }));
vi.mock('~/lib/.server/cloudflare/user-workspace-runtime-provisioner', () => ({ provisionUserWorkspaceRuntime }));

import {
  operationsReconcileRuntimeAction,
  operationsRuntimeVersionAction,
  operationsSessionAction,
} from './operations-boundary';

const secret = 'x'.repeat(48);

describe('private operations control-plane boundary', () => {
  beforeEach(() => {
    getAuthSession.mockReset();
    provisionUserWorkspaceRuntime.mockReset().mockResolvedValue({ status: 'ready', runtimeVersion: 'a'.repeat(64) });
  });

  it('issues a short-lived parent-domain cookie only to the configured owner session', async () => {
    getAuthSession.mockResolvedValue({ user: { id: 'owner-1', email: 'ferdousbd@gmail.com' } });
    const response = await operationsSessionAction({
      request: new Request('https://ghostbuild.dev/api/ops/session', { headers: { cookie: 'ghostbuild_session=x' } }),
      env: env(),
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://admin.ghostbuild.dev/');
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('Domain=.ghostbuild.dev');
    expect(cookie).toContain('HttpOnly; Secure; SameSite=Strict; Max-Age=900');
    const token = /ghostbuild_ops_session=([^;]+)/.exec(cookie)?.[1];
    expect(token).toBeTruthy();
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(token!.split('.')[0]!)));
    expect(payload).toMatchObject({ sub: 'owner-1', email: 'ferdousbd@gmail.com', aud: 'admin.ghostbuild.dev' });
    expect(payload.exp).toBeGreaterThan(Date.now());
  });

  it('conceals the broker from non-owner sessions', async () => {
    getAuthSession.mockResolvedValue({ user: { id: 'other', email: 'other@example.com' } });
    const response = await operationsSessionAction({
      request: new Request('https://ghostbuild.dev/api/ops/session'),
      env: env(),
    });
    expect(response.status).toBe(404);
    expect(response.headers.has('set-cookie')).toBe(false);
  });

  it('requires the shared secret before exposing the runtime version', async () => {
    const rejected = await operationsRuntimeVersionAction({
      request: new Request('https://ghostbuild.dev/api/internal/ops/runtime-version'),
      env: env(),
    });
    expect(rejected.status).toBe(404);

    const accepted = await operationsRuntimeVersionAction({
      request: serviceRequest('https://ghostbuild.dev/api/internal/ops/runtime-version'),
      env: env(),
    });
    expect(accepted.status).toBe(200);
    expect(((await accepted.json()) as { runtimeVersion: string }).runtimeVersion).toMatch(/^[a-f0-9]{64}$/);
  });

  it('reconciles only a bounded request for a user with an active connection', async () => {
    const prepare = vi.fn(() => ({
      bind: vi.fn(() => ({ first: vi.fn(async () => ({ id: 'connection-1' })) })),
    }));
    const runtimeEnv = env({ DB: { prepare } as unknown as D1Database });
    const request = serviceRequest('https://ghostbuild.dev/api/internal/ops/runtimes/reconcile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'user-1' }),
    });

    const response = await operationsReconcileRuntimeAction({ request, env: runtimeEnv });

    expect(response.status).toBe(200);
    expect(provisionUserWorkspaceRuntime).toHaveBeenCalledWith({
      env: runtimeEnv,
      userId: 'user-1',
      connectionId: 'connection-1',
    });
  });
});

function env(overrides: Partial<Env> = {}): Env {
  return {
    GHOSTBUILD_ADMIN_EMAIL: 'ferdousbd@gmail.com',
    OPS_AUTH_SECRET: { get: async () => secret },
    ...overrides,
  } as Env;
}

function serviceRequest(url: string, init: RequestInit = {}): Request {
  return new Request(url, {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${secret}` },
  });
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}
