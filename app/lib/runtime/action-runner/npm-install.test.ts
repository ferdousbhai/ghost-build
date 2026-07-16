import type { WebContainer } from '@webcontainer/api';
import { describe, expect, test, vi } from 'vitest';
import { runNpmInstall } from './npm-install';

vi.mock('~/lib/stores/containerBootState', () => ({
  ContainerBootState: { READY: 'ready' },
  waitForContainerBootState: vi.fn(() => Promise.resolve()),
}));

describe('runNpmInstall', () => {
  test('provides a constrained agent path for synchronizing pnpm-lock.yaml', async () => {
    const spawn = vi.fn(async () => ({
      output: new ReadableStream<string>({
        start(controller) {
          controller.close();
        },
      }),
      exit: Promise.resolve(0),
      kill: vi.fn(),
    }));
    const result = await runNpmInstall({
      invocation: { toolName: 'npmInstall', args: { mode: 'sync-lockfile' } } as never,
      container: { spawn } as unknown as WebContainer,
      abortSignal: new AbortController().signal,
      onOutput: vi.fn(),
    });
    expect(result).toBe('');
    expect(spawn).toHaveBeenCalledWith('pnpm', ['install', '--lockfile-only']);
  });
});
