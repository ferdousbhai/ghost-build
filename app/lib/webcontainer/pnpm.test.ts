import { describe, expect, test, vi } from 'vitest';
import { prepareWebContainerPnpm, webContainerPnpmCommand } from './pnpm';

describe('WebContainer pnpm command', () => {
  test('creates pnpm user config directory for fresh containers', async () => {
    const mkdir = vi.fn();

    await prepareWebContainerPnpm({ fs: { mkdir } } as never);

    expect(mkdir).toHaveBeenCalledWith('/home/.config/pnpm', { recursive: true });
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
