import { describe, expect, test } from 'vitest';
import { startupInstallArgs } from './dependency-install-policy';

describe('startup dependency installation policy', () => {
  test('uses the exact WebContainer-accelerated install command', () => {
    expect(startupInstallArgs()).toEqual(['install']);
  });
});
