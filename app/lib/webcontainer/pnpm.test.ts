import { describe, expect, test, vi } from 'vitest';
import { prepareWebContainerPnpm, webContainerPnpmCommand, webContainerPnpmEnvironment } from './pnpm';

describe('WebContainer pnpm command', () => {
  test('creates pnpm user config for fresh containers', async () => {
    const mkdir = vi.fn();
    const writeFile = vi.fn();

    await prepareWebContainerPnpm({ fs: { mkdir, writeFile } } as never);

    expect(mkdir).toHaveBeenCalledWith('.ghostbuild/pnpm-config/pnpm', { recursive: true });
    expect(writeFile).toHaveBeenCalledWith('.ghostbuild/pnpm-config/pnpm/config.yaml', '{}\n');
    expect(writeFile).toHaveBeenCalledWith('.npmrc', '');
  });

  test('directs pnpm to the project-visible managed config', () => {
    expect(webContainerPnpmEnvironment({ workdir: '/home/project' } as never)).toEqual({
      XDG_CONFIG_HOME: '/home/project/.ghostbuild/pnpm-config',
      npm_config_manage_package_manager_versions: 'false',
    });
  });

  test('uses the pinned pnpm version without registry lifecycle scripts', () => {
    expect(webContainerPnpmCommand(['install', '--frozen-lockfile'])).toEqual([
      'npx',
      '--yes',
      '--ignore-scripts',
      '--registry=https://registry.npmjs.org/',
      '--package=pnpm@10.34.0',
      '--',
      'pnpm',
      'install',
      '--frozen-lockfile',
    ]);
  });
});
