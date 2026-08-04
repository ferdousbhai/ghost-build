import { afterEach, describe, expect, it, vi } from 'vitest';
import { getUserRuntimeSession, resetUserRuntimeSession, userRuntimeEndpointStore } from './runtime-session';

afterEach(() => {
  resetUserRuntimeSession();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('user runtime session', () => {
  it('prepares the runtime through the single session endpoint', async () => {
    const request = vi.fn().mockResolvedValue(
      Response.json({
        endpoint: 'https://workspace.example/path',
        token: 'capability-token',
        expiresAt: Date.now() + 60_000,
      }),
    );
    vi.stubGlobal('fetch', request);

    await expect(getUserRuntimeSession()).resolves.toMatchObject({
      endpoint: 'https://workspace.example',
      token: 'capability-token',
    });

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith('/api/cloudflare/runtime-session', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    expect(userRuntimeEndpointStore.get()).toBe('https://workspace.example');
  });

  it('surfaces automatic provisioning failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ error: 'Unable to deploy the workspace.' }, { status: 502 })),
    );

    await expect(getUserRuntimeSession()).rejects.toThrow('Unable to deploy the workspace.');
    expect(userRuntimeEndpointStore.get()).toBeNull();
  });

  it('waits for the request that owns the provisioning lease', async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { code: 'workspace_preparing', error: 'The project workspace is already being prepared.' },
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          endpoint: 'https://workspace.example',
          token: 'capability-token',
          expiresAt: Date.now() + 60_000,
        }),
      );
    vi.stubGlobal('fetch', request);

    const session = getUserRuntimeSession();
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(session).resolves.toMatchObject({ endpoint: 'https://workspace.example' });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('stops lease polling when the account session resets', async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { code: 'workspace_preparing', error: 'The project workspace is already being prepared.' },
          { status: 409 },
        ),
      );
    vi.stubGlobal('fetch', request);

    const session = getUserRuntimeSession();
    const rejected = expect(session).rejects.toThrow('canceled');
    await vi.advanceTimersByTimeAsync(0);
    resetUserRuntimeSession();
    await vi.advanceTimersByTimeAsync(1_000);

    await rejected;
    expect(request).toHaveBeenCalledOnce();
  });
});
