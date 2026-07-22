import { describe, expect, test, vi } from 'vitest';
import { prepareWebContainerPnpm, webContainerPnpmCommand } from './pnpm';

describe('WebContainer pnpm command', () => {
  test('creates pnpm user config for fresh containers', async () => {
    const mkdir = vi.fn();
    const writeFile = vi.fn();

    await prepareWebContainerPnpm({ fs: { mkdir, writeFile } } as never);

    expect(mkdir).toHaveBeenCalledWith('/home/.config/pnpm', { recursive: true });
    expect(writeFile).toHaveBeenCalledWith('/home/.config/pnpm/config.yaml', '{}\n');
  });

  test('uses the pinned pnpm version without registry lifecycle scripts', () => {
    expect(webContainerPnpmCommand(['install', '--frozen-lockfile'])).toEqual([
      'npx',
      '--yes',
      '--ignore-scripts',
      '--registry=https://registry.npmjs.org/',
      '--package=pnpm@11.14.0',
      '--',
      'pnpm',
      'install',
      '--frozen-lockfile',
    ]);
  });
});
