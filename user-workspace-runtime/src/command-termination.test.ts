import { describe, expect, it, vi } from 'vitest';
import { terminateWorkspaceCommand } from './command-termination';

function harness(overrides: { killError?: Error; resultError?: Error } = {}) {
  const observer = {
    result: vi.fn(async () => {
      if (overrides.resultError) {
        throw overrides.resultError;
      }
      return { status: 'cancelled' };
    }),
    [Symbol.dispose]: vi.fn(),
  };
  const runtime = {
    killExec: vi.fn(async () => {
      if (overrides.killError) {
        throw overrides.killError;
      }
    }),
    getExec: vi.fn(async () => observer),
  };
  return { observer, runtime };
}

describe('workspace command termination', () => {
  it('uses SIGKILL and observes a terminal result before settling', async () => {
    const { observer, runtime } = harness();

    await terminateWorkspaceCommand(runtime, 'command-1', 'container-shell');

    expect(runtime.killExec).toHaveBeenCalledWith('command-1', {
      backend: 'container-shell',
      signal: 'SIGKILL',
    });
    expect(runtime.getExec).toHaveBeenCalledWith('command-1', {
      backend: 'container-shell',
      encoding: 'utf8',
      resume: 'tail',
    });
    expect(observer.result).toHaveBeenCalledOnce();
    expect(observer[Symbol.dispose]).toHaveBeenCalledOnce();
  });

  it('still requires terminal observation when the kill request itself fails', async () => {
    const { observer, runtime } = harness({ killError: new Error('kill response lost') });

    await terminateWorkspaceCommand(runtime, 'command-1', 'container-shell');

    expect(observer.result).toHaveBeenCalledOnce();
  });

  it('retries instead of reporting settlement when termination cannot yet be observed', async () => {
    const { observer, runtime } = harness({ resultError: new Error('terminal status unavailable') });
    const retry = deferred<void>();
    const retryDelay = vi.fn(() => retry.promise);

    const termination = terminateWorkspaceCommand(runtime, 'command-1', 'container-shell', retryDelay);
    await vi.waitFor(() => expect(retryDelay).toHaveBeenCalledOnce());

    let settled = false;
    void termination.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(observer[Symbol.dispose]).toHaveBeenCalledOnce();

    observer.result.mockResolvedValueOnce({ status: 'cancelled' });
    retry.resolve();
    await termination;
    expect(runtime.killExec).toHaveBeenCalledTimes(2);
    expect(observer[Symbol.dispose]).toHaveBeenCalledTimes(2);
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
