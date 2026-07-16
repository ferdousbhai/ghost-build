import type { WebContainer } from '@webcontainer/api';
import { describe, expect, test, vi } from 'vitest';
import { runNpmInstall } from './npm-install';
import { DiagnosticsStore } from './diagnostics-store';

vi.mock('~/lib/stores/containerBootState', () => ({
  ContainerBootState: { READY: 'ready' },
  waitForContainerBootState: vi.fn(() => Promise.resolve()),
}));

describe('runNpmInstall', () => {
  test('provides a constrained agent path for synchronizing pnpm-lock.yaml', async () => {
    const spawn = vi.fn(async () => process('', 0));
    const result = await runNpmInstall({
      invocation: { toolName: 'npmInstall', args: { mode: 'sync-lockfile' } } as never,
      container: { spawn } as unknown as WebContainer,
      abortSignal: new AbortController().signal,
      onOutput: vi.fn(),
      diagnostics: new DiagnosticsStore(),
    });
    expect(result).toMatchObject({ ok: true, data: { mode: 'sync-lockfile', exitCode: 0 } });
    expect(spawn).toHaveBeenCalledWith('pnpm', ['install', '--lockfile-only']);
  });

  test('turns failed command output into structured diagnostics', async () => {
    const spawn = vi.fn(async () => process('ERR_PNPM_FETCH_404: Package was not found\n', 1));
    const result = await runNpmInstall({
      invocation: { toolName: 'npmInstall', args: { packages: 'missing-package' } } as never,
      container: { spawn } as unknown as WebContainer,
      abortSignal: new AbortController().signal,
      onOutput: vi.fn(),
      diagnostics: new DiagnosticsStore(),
    });

    expect(result).toMatchObject({
      ok: false,
      data: {
        mode: 'add',
        exitCode: 1,
        diagnostics: [{ code: 'ERR_PNPM_FETCH_404', message: 'Package was not found' }],
      },
    });
  });
});

function process(output: string, exitCode: number) {
  return {
    output: new ReadableStream<string>({
      start(controller) {
        if (output) {
          controller.enqueue(output);
        }
        controller.close();
      },
    }),
    exit: Promise.resolve(exitCode),
    kill: vi.fn(),
  };
}
