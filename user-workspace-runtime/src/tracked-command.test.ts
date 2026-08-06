import { describe, expect, it, vi } from 'vitest';
import {
  runTrackedSandboxCommand,
  sandboxCommandFailureMessage,
  SandboxProcessTerminationUnconfirmedError,
} from './tracked-command';

describe('tracked Sandbox commands', () => {
  it('exposes the exact started process before waiting for it', async () => {
    const events: string[] = [];
    const process = {
      waitForExit: vi.fn(async () => {
        events.push('wait');
        return { exitCode: 0 };
      }),
      kill: vi.fn(async () => undefined),
      getStatus: vi.fn(async () => 'completed' as const),
      getLogs: vi.fn(async () => ({ stdout: '', stderr: '' })),
    };

    await runTrackedSandboxCommand({
      command: 'pnpm run build',
      timeout: 30_000,
      processId: 'transient-1',
      startProcess: async () => process,
      onProcess: (startedProcess) => {
        expect(startedProcess).toBe(process);
        events.push('attach');
      },
    });

    expect(events).toEqual(['attach', 'wait']);
  });

  it('kills a timed-out process before cleanup returns to the caller', async () => {
    const events: string[] = [];
    const process = {
      waitForExit: vi.fn(async () => {
        events.push('wait');
        throw new Error('timeout');
      }),
      kill: vi.fn(async () => {
        events.push('kill');
      }),
      getStatus: vi.fn(async () => {
        events.push('status');
        return 'killed' as const;
      }),
      getLogs: vi.fn(async () => {
        events.push('logs');
        return { stdout: '', stderr: 'build timed out' };
      }),
    };

    await expect(
      runTrackedSandboxCommand({
        command: 'pnpm run build',
        timeout: 30_000,
        processId: 'transient-1',
        startProcess: async (_command, options) => {
          expect(options.autoCleanup).toBe(false);
          return process;
        },
      }),
    ).rejects.toThrow('Sandbox command timed out after 30000ms.');
    events.push('rm');

    expect(events).toEqual(['wait', 'kill', 'status', 'logs', 'rm']);
    expect(process.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('fails closed when timeout cleanup cannot confirm termination', async () => {
    const process = {
      waitForExit: vi.fn(async () => {
        throw new Error('timeout');
      }),
      kill: vi.fn(async () => {
        throw new Error('rpc unavailable');
      }),
      getStatus: vi.fn(async () => {
        throw new Error('rpc unavailable');
      }),
      getLogs: vi.fn(async () => {
        throw new Error('rpc unavailable');
      }),
    };

    await expect(
      runTrackedSandboxCommand({
        command: 'pnpm run build',
        timeout: 30_000,
        processId: 'transient-1',
        startProcess: async () => process,
      }),
    ).rejects.toBeInstanceOf(SandboxProcessTerminationUnconfirmedError);
    expect(process.getStatus).toHaveBeenCalledOnce();
    expect(process.getLogs).not.toHaveBeenCalled();
  });

  it('accepts a kill race when status proves the process already exited', async () => {
    const process = {
      waitForExit: vi.fn(async () => {
        throw new Error('timeout');
      }),
      kill: vi.fn(async () => {
        throw new Error('not found');
      }),
      getStatus: vi.fn(async () => 'completed' as const),
      getLogs: vi.fn(async () => ({ stdout: '', stderr: '' })),
    };

    await expect(
      runTrackedSandboxCommand({
        command: 'pnpm run build',
        timeout: 30_000,
        processId: 'transient-1',
        startProcess: async () => process,
      }),
    ).rejects.toThrow('Sandbox command timed out after 30000ms.');
    expect(process.getStatus).toHaveBeenCalledOnce();
  });

  it('recovers persisted output when a fast failure outruns output callbacks', async () => {
    const process = {
      waitForExit: vi.fn(async () => ({ exitCode: 1 })),
      kill: vi.fn(async () => undefined),
      getStatus: vi.fn(async () => 'failed' as const),
      getLogs: vi.fn(async () => ({ stdout: 'build output', stderr: 'compiler failed' })),
    };

    await expect(
      runTrackedSandboxCommand({
        command: 'pnpm run build',
        timeout: 30_000,
        processId: 'transient-1',
        startProcess: async () => process,
      }),
    ).rejects.toThrow('Sandbox command failed with exit code 1.\ncompiler failed\nbuild output');
    expect(process.getLogs).toHaveBeenCalledOnce();
  });

  it('retains streamed output when persisted logs cannot be read', async () => {
    let emitOutput: ((stream: 'stdout' | 'stderr', data: string) => void) | undefined;
    const process = {
      waitForExit: vi.fn(async () => ({ exitCode: 1 })),
      kill: vi.fn(async () => undefined),
      getStatus: vi.fn(async () => 'failed' as const),
      getLogs: vi.fn(async () => {
        throw new Error('log RPC unavailable');
      }),
    };

    await expect(
      runTrackedSandboxCommand({
        command: 'pnpm run build',
        timeout: 30_000,
        processId: 'transient-1',
        startProcess: async (_command, options) => {
          emitOutput = options.onOutput;
          emitOutput('stderr', 'streamed failure');
          return process;
        },
      }),
    ).rejects.toThrow('Sandbox command failed with exit code 1.\nstreamed failure');
    expect(emitOutput).toBeDefined();
  });

  it('bounds persisted command output while retaining the failure summary', () => {
    const message = sandboxCommandFailureMessage(
      { stdout: 'x'.repeat(10_000), stderr: 'failure details' },
      { summary: 'Sandbox command failed with exit code 1.' },
    );

    expect(message).toHaveLength(4_000);
    expect(message).toMatch(/^Sandbox command failed with exit code 1\.\n/);
    expect(message).toContain('failure details');
    expect(message.endsWith('x'.repeat(100))).toBe(true);
  });

  it('reserves diagnostic space for both full stderr and stdout streams', () => {
    const message = sandboxCommandFailureMessage({ stdout: 'o'.repeat(10_000), stderr: 'e'.repeat(10_000) });

    expect(message).toHaveLength(4_000);
    expect(message).toContain(`\n${'o'.repeat(100)}`);
    expect(message).toContain('e'.repeat(100));
  });
});
