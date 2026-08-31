import { describe, expect, test, vi } from 'vitest';
import {
  UserWorkspaceRuntimeReadinessError,
  waitForUserWorkspaceRuntimeReadiness,
} from './user-workspace-runtime-readiness';

const runtimeVersion = 'a'.repeat(64);
const previousRuntimeVersion = 'b'.repeat(64);
const controlPlaneSecret = 's'.repeat(32);
const endpoint = 'https://workspace-runtime.example';

describe('user workspace runtime readiness', () => {
  test('retries propagation and D1 readiness responses before accepting the exact deployed digest', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ ok: false }, { status: 503 }))
      .mockResolvedValueOnce(Response.json(healthy(runtimeVersion)));
    const clock = fakeClock();

    await expect(
      waitForUserWorkspaceRuntimeReadiness({
        endpoint,
        controlPlaneSecret,
        runtimeVersion,
        request,
        now: clock.now,
        sleep: clock.sleep,
        random: () => 0,
      }),
    ).resolves.toBeUndefined();

    expect(request).toHaveBeenCalledTimes(3);
    expect(clock.sleep).toHaveBeenCalledTimes(2);
    expect(clock.delays).toEqual([375, 750]);
    for (const [url, init] of request.mock.calls) {
      expect(url).toBe('https://workspace-runtime.example/v1/readiness');
      expect(init).toMatchObject({ headers: { authorization: `Bearer ${controlPlaneSecret}` } });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  test('treats a valid previous digest as propagation but requires the exact new digest', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(healthy(previousRuntimeVersion)))
      .mockResolvedValueOnce(Response.json(healthy(runtimeVersion)));
    const clock = fakeClock();

    await expect(
      waitForUserWorkspaceRuntimeReadiness({
        endpoint,
        controlPlaneSecret,
        runtimeVersion,
        request,
        now: clock.now,
        sleep: clock.sleep,
        random: () => 0,
      }),
    ).resolves.toBeUndefined();

    expect(request).toHaveBeenCalledTimes(2);
    expect(clock.delays).toEqual([375]);
  });

  test.each([
    ['authentication rejection', new Response(null, { status: 401 })],
    ['bad request', new Response(null, { status: 400 })],
    ['redirect', new Response(null, { status: 302 })],
  ])('does not retry a terminal HTTP %s', async (_label, response) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response);
    const sleep = vi.fn(async () => undefined);

    await expect(
      waitForUserWorkspaceRuntimeReadiness({ endpoint, controlPlaneSecret, runtimeVersion, request, sleep }),
    ).rejects.toThrow(UserWorkspaceRuntimeReadinessError);

    expect(request).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  test.each([
    ['invalid JSON', new Response('{', { headers: { 'content-type': 'application/json' } })],
    ['wrong service', Response.json({ ...healthy(runtimeVersion), service: 'some-other-service' })],
    ['invalid digest', Response.json({ ...healthy(runtimeVersion), runtimeVersion: 'not-a-digest' })],
  ])('does not retry a malformed success response: %s', async (_label, response) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response);
    const sleep = vi.fn(async () => undefined);

    await expect(
      waitForUserWorkspaceRuntimeReadiness({ endpoint, controlPlaneSecret, runtimeVersion, request, sleep }),
    ).rejects.toThrow('invalid health response');

    expect(request).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  test('honors Retry-After within the strict deadline', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'retry-after': '2' } }))
      .mockResolvedValueOnce(Response.json(healthy(runtimeVersion)));
    const clock = fakeClock();

    await waitForUserWorkspaceRuntimeReadiness({
      endpoint,
      controlPlaneSecret,
      runtimeVersion,
      request,
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0,
    });

    expect(clock.delays).toEqual([2_000]);
  });

  test('bounds transient network retries by the total deadline without real sleeps', async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    const clock = fakeClock();

    await expect(
      waitForUserWorkspaceRuntimeReadiness({
        endpoint,
        controlPlaneSecret,
        runtimeVersion,
        request,
        now: clock.now,
        sleep: clock.sleep,
        random: () => 0,
        deadlineMs: 1_000,
      }),
    ).rejects.toThrow('health-check deadline');

    expect(request).toHaveBeenCalledTimes(2);
    expect(clock.delays).toEqual([375, 625]);
    expect(clock.now()).toBe(1_000);
  });

  test('reports actionable component codes from the last authenticated transient response', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(unhealthy(runtimeVersion, 'container', 'unavailable'), { status: 503 }))
      .mockRejectedValueOnce(new TypeError('fetch failed'));
    const clock = fakeClock();

    await expect(
      waitForUserWorkspaceRuntimeReadiness({
        endpoint,
        controlPlaneSecret,
        runtimeVersion,
        request,
        now: clock.now,
        sleep: clock.sleep,
        random: () => 0,
        deadlineMs: 1_000,
      }),
    ).rejects.toThrow('health-check deadline. Readiness checks still failing: container (unavailable)');

    expect(request).toHaveBeenCalledTimes(2);
  });

  test('does not expose unrecognized component codes from a transient response', async () => {
    const sensitiveCode = 'secret_account_token_123';
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(unhealthy(runtimeVersion, 'container', sensitiveCode), { status: 503 }));
    const clock = fakeClock();

    const result = waitForUserWorkspaceRuntimeReadiness({
      endpoint,
      controlPlaneSecret,
      runtimeVersion,
      request,
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0,
      deadlineMs: 1,
    });

    await expect(result).rejects.toThrow('health-check deadline.');
    await expect(result).rejects.not.toThrow(sensitiveCode);
  });

  test('does not retry unexpected request failures', async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error('programming error'));
    const sleep = vi.fn(async () => undefined);

    await expect(
      waitForUserWorkspaceRuntimeReadiness({ endpoint, controlPlaneSecret, runtimeVersion, request, sleep }),
    ).rejects.toThrow('invalid health response');

    expect(request).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  test('polls until the deadline rather than stopping at the old thirty-attempt cap', async () => {
    // A container that stays unavailable models a cold first start. The attempt cap used to give up
    // after thirty polls — about two and a half minutes at the backoff ceiling — long before the
    // ten-minute deadline, so a container still booting was declared failed. A fresh response per
    // call is required because the body is read each time.
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json(unhealthy(runtimeVersion, 'container', 'unavailable'), { status: 503 }),
      );
    const clock = fakeClock();

    await expect(
      waitForUserWorkspaceRuntimeReadiness({
        endpoint,
        controlPlaneSecret,
        runtimeVersion,
        request,
        now: clock.now,
        sleep: clock.sleep,
        random: () => 0,
      }),
    ).rejects.toThrow('health-check deadline. Readiness checks still failing: container (unavailable)');

    // The deadline is the bound, not the attempt cap: far more than thirty polls, stopping short of
    // the 200-attempt safety ceiling, with the full ten-minute budget consumed.
    expect(request.mock.calls.length).toBeGreaterThan(30);
    expect(request.mock.calls.length).toBeLessThan(200);
    expect(clock.now()).toBe(10 * 60_000);
  });
});

function healthy(version: string) {
  const check = { ok: true, code: 'ready', durationMs: 1 };
  return {
    ok: true,
    service: 'ghostbuild-user-workspace-runtime',
    runtimeVersion: version,
    checkedAt: '2026-08-04T00:00:00.000Z',
    components: {
      runtime: check,
      database: check,
      projectWorkspaceRpc: check,
      durableVfs: check,
      container: check,
      fuse: check,
      sync: check,
      cleanup: check,
    },
  } as const;
}

function unhealthy(version: string, component: keyof ReturnType<typeof healthy>['components'], code: string) {
  const payload = healthy(version);
  return {
    ...payload,
    ok: false,
    components: {
      ...payload.components,
      [component]: { ok: false, code, durationMs: 1 },
    },
  };
}

function fakeClock() {
  let current = 0;
  const delays: number[] = [];
  return {
    now: () => current,
    sleep: vi.fn(async (milliseconds: number) => {
      delays.push(milliseconds);
      current += milliseconds;
    }),
    delays,
  };
}
