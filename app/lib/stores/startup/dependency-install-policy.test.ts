import { describe, expect, test } from 'vitest';
import { startupInstallArgs } from './dependency-install-policy';

describe('startup dependency installation policy', () => {
  test.each(['ci', 'install'] as const)('disables project hooks and lifecycle scripts for %s restores', (mode) => {
    expect(startupInstallArgs(mode)).toEqual([
      mode,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--registry=https://registry.npmjs.org/',
    ]);
  });
});
