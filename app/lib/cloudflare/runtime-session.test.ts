import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  aiGatewayCreditStatusStore,
  fetchUserRuntime,
  getUserRuntimeSession,
  resetUserRuntimeSession,
  UserRuntimeSessionError,
  userRuntimeEndpointStore,
} from './runtime-session';

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
        aiGatewayCreditStatus: 'available',
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
    expect(aiGatewayCreditStatusStore.get()).toBe('available');
  });

  it('uses an unknown credit status when an older server response omits it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          endpoint: 'https://workspace.example',
          token: 'capability-token',
          expiresAt: Date.now() + 60_000,
        }),
      ),
    );

    await getUserRuntimeSession();

    expect(aiGatewayCreditStatusStore.get()).toBe('unknown');
  });

  it('surfaces automatic provisioning failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ error: 'Unable to deploy the workspace.' }, { status: 502 })),
    );

    await expect(getUserRuntimeSession()).rejects.toThrow('Unable to deploy the workspace.');
    expect(userRuntimeEndpointStore.get()).toBeNull();
  });

  it('preserves a stable recovery code without exposing provider details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          {
            code: 'workspace_plan_required',
            error: 'Enable Workers Paid in Cloudflare, then return and try again.',
          },
          { status: 502 },
        ),
      ),
    );

    await expect(getUserRuntimeSession()).rejects.toEqual(
      new UserRuntimeSessionError(
        'Enable Workers Paid in Cloudflare, then return and try again.',
        'workspace_plan_required',
      ),
    );
  });

  it('preserves the Cloudflare reauthorization recovery code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          {
            code: 'cloudflare_reauthorization_required',
            error: 'Reauthorize Cloudflare, then try again.',
          },
          { status: 409 },
        ),
      ),
    );

    await expect(getUserRuntimeSession()).rejects.toEqual(
      new UserRuntimeSessionError('Reauthorize Cloudflare, then try again.', 'cloudflare_reauthorization_required'),
    );
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

  it('lets a caller cancel its wait without cancelling shared provisioning', async () => {
    let finishProvisioning: ((response: Response) => void) | undefined;
    const request = vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        finishProvisioning = resolve;
      }),
    );
    vi.stubGlobal('fetch', request);
    const caller = new AbortController();

    const canceledWait = fetchUserRuntime('/v1/data', { signal: caller.signal });
    const sharedWait = getUserRuntimeSession();
    const canceled = expect(canceledWait).rejects.toMatchObject({ name: 'AbortError', message: 'Query cancelled' });
    caller.abort(new DOMException('Query cancelled', 'AbortError'));

    await canceled;
    expect(request).toHaveBeenCalledOnce();

    finishProvisioning?.(
      Response.json({
        endpoint: 'https://workspace.example',
        token: 'capability-token',
        expiresAt: Date.now() + 60_000,
      }),
    );
    await expect(sharedWait).resolves.toMatchObject({ endpoint: 'https://workspace.example' });
    expect(userRuntimeEndpointStore.get()).toBe('https://workspace.example');
    expect(request).toHaveBeenCalledOnce();
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
