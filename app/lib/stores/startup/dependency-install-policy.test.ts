import { describe, expect, test } from 'vitest';
import { startupInstallArgs } from './dependency-install-policy';

describe('startup dependency installation policy', () => {
  test.each(['--frozen-lockfile', '--no-frozen-lockfile'] as const)(
    'disables project hooks and lifecycle scripts for %s restores',
    (lockfileMode) => {
      expect(startupInstallArgs(lockfileMode)).toEqual([
        'install',
        lockfileMode,
        '--ignore-scripts',
        '--ignore-pnpmfile',
        '--registry=https://registry.npmjs.org/',
      ]);
    },
  );
});
