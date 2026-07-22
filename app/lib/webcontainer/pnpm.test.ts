import { describe, expect, test } from 'vitest';
import { webContainerPnpmCommand } from './pnpm';

describe('WebContainer pnpm command', () => {
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
