import { afterEach, describe, expect, it, vi } from 'vitest';
import { destroySandboxWithRetries, sandboxExec } from './sandbox-lifecycle';

describe('sandbox lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('bounds the outer RPC beyond the container command deadline', async () => {
    vi.useFakeTimers();
    const exec = vi.fn(() => new Promise<never>(() => undefined));
    const operation = sandboxExec({ exec } as never, 'blocked command', { timeout: 1_000 });
    const assertion = expect(operation).rejects.toThrow('Sandbox RPC timed out after the 1000 ms command deadline.');

    await vi.advanceTimersByTimeAsync(16_000);

    await assertion;
  });

  it('retries transient destroy failures before releasing cleanup', async () => {
    vi.useFakeTimers();
    const destroy = vi
      .fn()
      .mockRejectedValueOnce(new Error('Durable Object reset'))
      .mockRejectedValueOnce(new Error('container state unavailable'))
      .mockResolvedValueOnce(undefined);
    const cleanup = destroySandboxWithRetries({ destroy } as never, 'test sandbox');

    await vi.advanceTimersByTimeAsync(1_250);
    await expect(cleanup).resolves.toEqual({ destroyed: true });

    expect(destroy).toHaveBeenCalledTimes(3);
  });

  it('logs one bounded failure after cleanup retries are exhausted', async () => {
    vi.useFakeTimers();
    const error = new Error('container state unavailable');
    const destroy = vi.fn().mockRejectedValue(error);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const cleanup = destroySandboxWithRetries({ destroy } as never, 'test sandbox');

    await vi.advanceTimersByTimeAsync(1_250);
    await expect(cleanup).resolves.toEqual({ destroyed: false, error });

    expect(destroy).toHaveBeenCalledTimes(3);
    expect(consoleError).toHaveBeenCalledWith('Unable to destroy test sandbox after cleanup retries', error);
  });
});
