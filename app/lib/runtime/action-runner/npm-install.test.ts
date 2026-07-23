import type { WebContainer } from '@webcontainer/api';
import { afterEach, describe, expect, test, vi } from 'vitest';
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
      container: containerWithWorkspace(spawn),
      abortSignal: new AbortController().signal,
      onOutput: vi.fn(),
      diagnostics: new DiagnosticsStore(),
    });
    expect(result).toMatchObject({ ok: true, data: { mode: 'sync-lockfile', exitCode: 0 } });
    expect(spawn).toHaveBeenCalledWith(
      'npx',
      [
        '--yes',
        '--ignore-scripts',
        '--registry=https://registry.npmjs.org/',
        '--package=pnpm@9.15.9',
        '--',
        'pnpm',
        'install',
        '--lockfile-only',
        '--ignore-pnpmfile',
        '--package-import-method=copy',
        '--reporter=append-only',
        '--registry=https://registry.npmjs.org/',
      ],
      {
        env: {
          XDG_CONFIG_HOME: '/home/project/.ghostbuild/pnpm-config',
          CI: 'true',
          npm_config_manage_package_manager_versions: 'false',
        },
      },
    );
  });

  test('turns failed command output into structured diagnostics', async () => {
    const spawn = vi.fn(async () => process('ERR_PNPM_FETCH_404: Package was not found\n', 1));
    const result = await runNpmInstall({
      invocation: { toolName: 'npmInstall', args: { packages: 'missing-package' } } as never,
      container: containerWithWorkspace(spawn),
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

  test('rejects a workspace-wide build-script bypass before spawning pnpm', async () => {
    const spawn = vi.fn(async () => process('', 0));
    const result = await runNpmInstall({
      invocation: { toolName: 'npmInstall', args: { packages: 'date-fns' } } as never,
      container: containerWithWorkspace(spawn, 'dangerouslyAllowAllBuilds: true\n'),
      abortSignal: new AbortController().signal,
      onOutput: vi.fn(),
      diagnostics: new DiagnosticsStore(),
    });

    expect(result).toMatchObject({ ok: false, summary: expect.stringContaining('dangerouslyAllowAllBuilds') });
    expect(spawn).not.toHaveBeenCalled();
  });

  test('terminates a dependency command that exceeds its deadline', async () => {
    vi.useFakeTimers();
    const hanging = process('', 0, new Promise<number>(() => undefined));
    const spawn = vi.fn(async () => hanging);
    const resultPromise = runNpmInstall({
      invocation: { toolName: 'npmInstall', args: { packages: 'date-fns' } } as never,
      container: containerWithWorkspace(spawn),
      abortSignal: new AbortController().signal,
      onOutput: vi.fn(),
      diagnostics: new DiagnosticsStore(),
    });
    await vi.advanceTimersByTimeAsync(120_001);
    const result = await resultPromise;
    expect(result).toMatchObject({ ok: false, data: { mode: 'add' } });
    expect(hanging.kill).toHaveBeenCalledOnce();
  });
});

afterEach(() => {
  vi.useRealTimers();
});

function process(output: string, exitCode: number, exit: Promise<number> = Promise.resolve(exitCode)) {
  return {
    output: new ReadableStream<string>({
      start(controller) {
        if (output) {
          controller.enqueue(output);
        }
        controller.close();
      },
    }),
    exit,
    kill: vi.fn(),
  };
}

function containerWithWorkspace(
  spawn: ReturnType<typeof vi.fn>,
  workspace = 'packages:\n  - .\nignoreWorkspaceRootCheck: true\nminimumReleaseAge: 1440\n' +
    'minimumReleaseAgeIgnoreMissingTime: false\nminimumReleaseAgeStrict: true\n' +
    'strictDepBuilds: true\nblockExoticSubdeps: true\nallowBuilds:\n' +
    '  core-js-pure: true\n  esbuild: true\n  sharp: true\n  workerd: true\n',
): WebContainer {
  return {
    spawn,
    workdir: '/home/project',
    fs: { mkdir: vi.fn(), readFile: vi.fn(async () => workspace), writeFile: vi.fn() },
  } as unknown as WebContainer;
}
