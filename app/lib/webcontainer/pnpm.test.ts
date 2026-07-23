import { describe, expect, test, vi } from 'vitest';
import { MANAGED_WEBCONTAINER_NPMRC_CONTENT } from '~/utils/secretFiles';
import {
  prepareWebContainerPackageManagers,
  webContainerNpmEnvironment,
  webContainerPnpmCommand,
  webContainerPnpmEnvironment,
} from './pnpm';

describe('WebContainer pnpm command', () => {
  test('creates pnpm user config for fresh containers', async () => {
    const mkdir = vi.fn();
    const writeFile = vi.fn();

    await prepareWebContainerPackageManagers({ fs: { mkdir, writeFile } } as never);

    expect(mkdir).toHaveBeenCalledWith('.ghostbuild/pnpm-config/pnpm', { recursive: true });
    expect(writeFile).toHaveBeenCalledWith('.ghostbuild/pnpm-config/pnpm/config.yaml', '{}\n');
    expect(writeFile).toHaveBeenCalledWith('.npmrc', MANAGED_WEBCONTAINER_NPMRC_CONTENT);
  });

  test('directs pnpm to the project-visible managed config', () => {
    expect(webContainerNpmEnvironment()).toEqual({
      CI: 'true',
      npm_config_ignore_scripts: 'true',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_registry: 'https://registry.npmjs.org/',
    });
    expect(webContainerPnpmEnvironment({ workdir: '/home/project' } as never)).toEqual({
      XDG_CONFIG_HOME: '/home/project/.ghostbuild/pnpm-config',
      CI: 'true',
      npm_config_ignore_scripts: 'true',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_registry: 'https://registry.npmjs.org/',
      npm_config_manage_package_manager_versions: 'false',
    });
  });

  test('uses the pinned pnpm version without registry lifecycle scripts', () => {
    expect(webContainerPnpmCommand(['install', '--frozen-lockfile'])).toEqual([
      'npx',
      '--yes',
      '--ignore-scripts',
      '--registry=https://registry.npmjs.org/',
      '--package=pnpm@9.15.9',
      '--',
      'pnpm',
      'install',
      '--frozen-lockfile',
    ]);
  });
});
