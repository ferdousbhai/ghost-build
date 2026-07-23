import type { WebContainer } from '@webcontainer/api';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { runNpmInstall } from './npm-install';
import { DiagnosticsStore } from './diagnostics-store';

vi.mock('~/lib/stores/containerBootState', () => ({
  ContainerBootState: { READY: 'ready' },
  waitForContainerBootState: vi.fn(() => Promise.resolve()),
}));

describe('runNpmInstall', () => {
  test('synchronizes the browser lockfile without resolving the production graph', async () => {
    const spawn = vi.fn(async () => process('', 0));
    const result = await runNpmInstall({
      invocation: { toolName: 'npmInstall', args: { mode: 'sync-lockfile' } } as never,
      container: containerWithWorkspace(spawn),
      abortSignal: new AbortController().signal,
      onOutput: vi.fn(),
      diagnostics: new DiagnosticsStore(),
    });
    expect(result).toMatchObject({ ok: true, data: { mode: 'sync-lockfile', exitCode: 0 } });
    expect(spawn).toHaveBeenCalledWith('npm', ['install'], {
      env: {
        CI: 'true',
        npm_config_ignore_scripts: 'true',
        npm_config_audit: 'false',
        npm_config_fund: 'false',
        npm_config_registry: 'https://registry.npmjs.org/',
      },
    });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  test('merges browser-resolved dependency versions back into package.json', async () => {
    const spawn = vi.fn(async () => process('', 0));
    const container = containerWithWorkspace(spawn);
    const result = await runNpmInstall({
      invocation: { toolName: 'npmInstall', args: { packages: 'date-fns' } } as never,
      container,
      abortSignal: new AbortController().signal,
      onOutput: vi.fn(),
      diagnostics: new DiagnosticsStore(),
    });

    expect(result).toMatchObject({ ok: true, data: { mode: 'add', exitCode: 0 } });
    expect(container.fs.writeFile).toHaveBeenLastCalledWith(
      'package.json',
      expect.stringContaining('"date-fns": "^4.0.0"'),
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

  test('rejects a workspace-wide build-script bypass before spawning npm', async () => {
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
  const invokeSpawn = spawn as unknown as (command: string, args: string[], options: unknown) => Promise<unknown>;
  const files = new Map([
    ['package.json', '{"name":"generated","dependencies":{"react":"19.0.0"},"devDependencies":{"vite":"8.0.0"}}\n'],
    [
      'package-lock.json',
      '{"lockfileVersion":3,"packages":{"":{"dependencies":{"react":"19.0.0"},"devDependencies":{"vite":"8.0.0"}},"node_modules/react":{"version":"19.0.0"},"node_modules/vite":{"version":"8.0.0"}}}\n',
    ],
    [
      'preview-runtime/package-lock.json',
      '{"lockfileVersion":3,"packages":{"":{"dependencies":{"react":"19.0.0"},"devDependencies":{"vite":"6.4.3"}},"node_modules/react":{"version":"19.0.0"},"node_modules/vite":{"version":"6.4.3"}}}\n',
    ],
  ]);
  return {
    spawn: vi.fn(async (command: string, args: string[], options: unknown) => {
      if (command === 'npm' && args.includes('date-fns')) {
        files.set(
          'package.json',
          '{"name":"generated","dependencies":{"react":"19.0.0","date-fns":"^4.0.0"},"devDependencies":{"vite":"6.4.3"}}\n',
        );
      }
      return invokeSpawn(command, args, options);
    }),
    workdir: '/home/project',
    fs: {
      mkdir: vi.fn(),
      readFile: vi.fn(async (path: string) => {
        if (path === 'pnpm-workspace.yaml') {
          return workspace;
        }
        const content = files.get(path);
        if (content === undefined) {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        }
        return content;
      }),
      writeFile: vi.fn(async (path: string, content: string) => {
        files.set(path, content);
      }),
    },
  } as unknown as WebContainer;
}
