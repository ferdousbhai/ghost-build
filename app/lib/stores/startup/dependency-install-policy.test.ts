import { describe, expect, test } from 'vitest';
import { startupInstallArgs } from './dependency-install-policy';

describe('startup dependency installation policy', () => {
  test('uses the WebContainer-accelerated install path without hooks or audit requests', () => {
    expect(startupInstallArgs()).toEqual([
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--registry=https://registry.npmjs.org/',
    ]);
  });
});
