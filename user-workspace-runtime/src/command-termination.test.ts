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

  it('retries observation after a kill error when terminal observation is retryable', async () => {
    const { observer, runtime } = harness({
      killError: new SyntaxError('kill endpoint rejected the request'),
      resultError: Object.assign(new Error('terminal status unavailable'), { retryable: true }),
    });
    const retry = deferred<void>();
    const termination = terminateWorkspaceCommand(runtime, 'command-1', 'container-shell', () => retry.promise);
    await vi.waitFor(() => expect(observer.result).toHaveBeenCalledOnce());

    observer.result.mockResolvedValueOnce({ status: 'cancelled' });
    retry.resolve();

    await expect(termination).resolves.toEqual({ status: 'cancelled' });
    expect(runtime.killExec).toHaveBeenCalledTimes(2);
    expect(observer.result).toHaveBeenCalledTimes(2);
  });

  it('retries instead of reporting settlement when termination cannot yet be observed', async () => {
    const { observer, runtime } = harness({
      resultError: Object.assign(new Error('terminal status unavailable'), { retryable: true }),
    });
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

  it('disposes an observer that resolves after its getExec attempt times out', async () => {
    vi.useFakeTimers();
    try {
      const lateObserver = {
        result: vi.fn(async () => ({ status: 'cancelled' })),
        [Symbol.dispose]: vi.fn(),
      };
      const retryObserver = {
        result: vi.fn(async () => ({ status: 'cancelled' })),
        [Symbol.dispose]: vi.fn(),
      };
      const lateGetExec = deferred<typeof lateObserver>();
      const runtime = {
        killExec: vi.fn(async () => undefined),
        getExec: vi
          .fn()
          .mockImplementationOnce(() => lateGetExec.promise)
          .mockResolvedValueOnce(retryObserver),
      };

      const termination = terminateWorkspaceCommand(
        runtime,
        'command-late-observer',
        'container-shell',
        async () => undefined,
        { attemptTimeoutMs: 10, overallTimeoutMs: 100 },
      );
      await vi.advanceTimersByTimeAsync(10);
      await termination;

      expect(runtime.getExec).toHaveBeenCalledTimes(2);
      expect(retryObserver[Symbol.dispose]).toHaveBeenCalledOnce();
      expect(lateObserver[Symbol.dispose]).not.toHaveBeenCalled();

      lateGetExec.resolve(lateObserver);
      await Promise.resolve();
      expect(lateObserver[Symbol.dispose]).toHaveBeenCalledOnce();
      expect(lateObserver.result).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds hung termination RPCs and terminal observation by the overall deadline', async () => {
    vi.useFakeTimers();
    try {
      const pending = new Promise<never>(() => undefined);
      const observer = { result: vi.fn(() => pending), [Symbol.dispose]: vi.fn() };
      const runtime = {
        killExec: vi.fn(async () => undefined),
        getExec: vi.fn(async () => observer),
      };
      const termination = terminateWorkspaceCommand(runtime, 'command-hung', 'container-shell', () => pending, {
        attemptTimeoutMs: 10,
        overallTimeoutMs: 50,
      });
      const rejection = expect(termination).rejects.toMatchObject({
        name: 'WorkspaceCommandTerminationIndeterminateError',
        code: 'workspace_command_termination_indeterminate',
      });

      await vi.advanceTimersByTimeAsync(50);
      await rejection;
      expect(observer[Symbol.dispose]).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces permanent observation failures as typed indeterminate outcomes without retrying', async () => {
    const failure = new SyntaxError('unknown command identifier');
    const { runtime } = harness({ resultError: failure });
    const retryDelay = vi.fn(async () => undefined);

    await expect(
      terminateWorkspaceCommand(runtime, 'tool:call-install', 'container-shell', retryDelay),
    ).rejects.toMatchObject({
      name: 'WorkspaceCommandTerminationIndeterminateError',
      code: 'workspace_command_termination_indeterminate',
      cause: failure,
    });
    expect(retryDelay).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
