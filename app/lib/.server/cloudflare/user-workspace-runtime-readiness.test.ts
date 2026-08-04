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
      expect(url).toBe('https://workspace-runtime.example/v1/health');
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

  test('does not retry unexpected request failures', async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error('programming error'));
    const sleep = vi.fn(async () => undefined);

    await expect(
      waitForUserWorkspaceRuntimeReadiness({ endpoint, controlPlaneSecret, runtimeVersion, request, sleep }),
    ).rejects.toThrow('invalid health response');

    expect(request).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });
});

function healthy(version: string) {
  return {
    ok: true,
    service: 'ghostbuild-user-workspace-runtime',
    runtimeVersion: version,
  } as const;
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
