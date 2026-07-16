import { afterEach, describe, expect, test, vi } from 'vitest';
import type { WebContainer, WebContainerProcess } from '@webcontainer/api';
import { ActionCommandTimeoutError } from './errors';
import { runCommand } from './command';

afterEach(() => {
  vi.useRealTimers();
});

describe('runCommand cancellation', () => {
  test('does not spawn when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const spawn = vi.fn();

    await expect(
      runCommand({
        container: { spawn } as unknown as WebContainer,
        command: ['pnpm', 'run', 'build'],
        abortSignal: controller.signal,
        onOutput: vi.fn(),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(spawn).not.toHaveBeenCalled();
  });

  test('kills a process that resolves after the spawn timeout', async () => {
    vi.useFakeTimers();
    let resolveSpawn!: (process: WebContainerProcess) => void;
    const spawnPromise = new Promise<WebContainerProcess>((resolve) => {
      resolveSpawn = resolve;
    });
    const spawn = vi.fn(() => spawnPromise);
    const process = { kill: vi.fn() } as unknown as WebContainerProcess;

    const command = runCommand({
      container: { spawn } as unknown as WebContainer,
      command: ['pnpm', 'run', 'build'],
      abortSignal: new AbortController().signal,
      onOutput: vi.fn(),
      timeoutMs: 100,
    });
    const rejection = expect(command).rejects.toBeInstanceOf(ActionCommandTimeoutError);

    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    resolveSpawn(process);
    await Promise.resolve();
    await Promise.resolve();

    expect(process.kill).toHaveBeenCalledOnce();
  });
});
