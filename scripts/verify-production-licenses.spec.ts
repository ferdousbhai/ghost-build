import { describe, expect, it } from 'vitest';
import {
  createSpdxDocument,
  createThirdPartyLicenseArtifact,
  findLicenseNoticeErrors,
  findLicensePolicyErrors,
  flattenLicenseReport,
  isPlatformNeutralProductionPackage,
} from './verify-production-licenses.mjs';

const policy = {
  schemaVersion: 1,
  reviewedAt: '2026-07-20',
  allowedLicenseExpressions: ['Apache-2.0', 'MIT/X11'],
  spdxLicenseNormalizations: { 'MIT/X11': 'MIT' },
  metadataOnlyPackageAllowlist: ['metadata-only@1.0.0'],
};

describe('production dependency license inventory', () => {
  it('flattens and sorts pnpm license output without local installation paths', () => {
    expect(
      flattenLicenseReport({
        MIT: [{ name: 'z-package', versions: ['2.0.0'], paths: ['/private/install'], license: 'MIT' }],
        'Apache-2.0': [{ name: 'a-package', versions: ['1.0.0'], paths: ['/other/install'], license: 'Apache-2.0' }],
      }),
    ).toEqual([
      {
        name: 'a-package',
        version: '1.0.0',
        reportedLicense: 'Apache-2.0',
        packageLicense: 'Apache-2.0',
      },
      { name: 'z-package', version: '2.0.0', reportedLicense: 'MIT', packageLicense: 'MIT' },
    ]);
  });

  it('uses one platform-neutral inventory on macOS, Linux, and other build hosts', () => {
    expect(isPlatformNeutralProductionPackage({ name: 'portable' })).toBe(true);
    expect(isPlatformNeutralProductionPackage({ name: 'darwin-binding', os: ['darwin'], cpu: ['arm64'] })).toBe(false);
    expect(isPlatformNeutralProductionPackage({ name: 'linux-binding', os: ['linux'], cpu: ['x64'] })).toBe(false);
    expect(isPlatformNeutralProductionPackage({ name: 'musl-binding', libc: ['musl'] })).toBe(false);
  });

  it('fails closed for unreviewed, inconsistent, and duplicate licenses', () => {
    expect(
      findLicensePolicyErrors(
        [
          { name: 'unsafe', version: '1.0.0', reportedLicense: 'AGPL-3.0-only', packageLicense: 'AGPL-3.0-only' },
          { name: 'unsafe', version: '1.0.0', reportedLicense: 'MIT', packageLicense: 'UNKNOWN' },
        ],
        policy,
      ),
    ).toEqual([
      'unsafe@1.0.0 declares unreviewed production license "AGPL-3.0-only".',
      'Production dependency inventory contains duplicate unsafe@1.0.0.',
      'unsafe@1.0.0 license grouping "MIT" does not match package metadata "UNKNOWN".',
      'unsafe@1.0.0 declares unreviewed production license "MIT".',
    ]);
  });

  it('creates a deterministic SPDX 2.3 document with normalized license identifiers', () => {
    const packages = [
      { name: 'buffer-builder', version: '0.2.0', reportedLicense: 'MIT/X11', packageLicense: 'MIT/X11' },
      { name: 'example', version: '1.0.0', reportedLicense: 'Apache-2.0', packageLicense: 'Apache-2.0' },
    ];
    const first = createSpdxDocument(packages, policy, 'lockfile');
    const second = createSpdxDocument(packages, policy, 'lockfile');

    expect(first).toEqual(second);
    expect(first).toMatchObject({ spdxVersion: 'SPDX-2.3', dataLicense: 'CC0-1.0' });
    expect(first.packages[0]).toMatchObject({ licenseDeclared: 'MIT', filesAnalyzed: false });
    expect(JSON.stringify(first)).not.toContain('/private/install');
  });

  it('creates a deterministic exact-version notice artifact and deduplicates verbatim text', () => {
    const packages = [
      {
        name: 'example-a',
        version: '1.0.0',
        reportedLicense: 'Apache-2.0',
        author: 'Example A',
        repository: 'https://example.test/a',
        homepage: undefined,
        hasPackageLicenseEvidence: true,
        licenseFiles: [{ path: 'LICENSE', content: 'exact license text\n' }],
      },
      {
        name: 'example-b',
        version: '2.0.0',
        reportedLicense: 'Apache-2.0',
        author: undefined,
        repository: { type: 'git', url: 'https://example.test/b.git' },
        homepage: 'https://example.test/b',
        hasPackageLicenseEvidence: true,
        licenseFiles: [{ path: 'NOTICE.txt', content: 'exact license text\n' }],
      },
    ];
    const first = createThirdPartyLicenseArtifact(packages, policy, 'lockfile');
    const second = createThirdPartyLicenseArtifact(packages, policy, 'lockfile');

    expect(first).toBe(second);
    expect(first).toContain('example-a@1.0.0');
    expect(first).toContain('example-b@2.0.0');
    expect(first.match(/----- BEGIN VERBATIM CONTENT -----/g)).toHaveLength(1);
    expect(first).not.toContain('/private/install');
  });

  it('requires exact review for packages that publish no license file', () => {
    const packages = [
      { name: 'metadata-only', version: '1.0.0', hasPackageLicenseEvidence: false, licenseFiles: [] },
      { name: 'unreviewed', version: '2.0.0', hasPackageLicenseEvidence: false, licenseFiles: [] },
      {
        name: 'nested-only',
        version: '1.0.0',
        hasPackageLicenseEvidence: false,
        licenseFiles: [{ path: 'vendor/component/LICENSE', content: 'vendored notice' }],
      },
      {
        name: 'now-complete',
        version: '3.0.0',
        hasPackageLicenseEvidence: true,
        licenseFiles: [{ path: 'LICENSE', content: 'text' }],
      },
    ];
    expect(
      findLicenseNoticeErrors(packages, {
        metadataOnlyPackageAllowlist: ['metadata-only@1.0.0', 'now-complete@3.0.0', 'removed@1.0.0'],
      }),
    ).toEqual([
      'unreviewed@2.0.0 publishes no package-level license evidence; review it and add the exact version to metadataOnlyPackageAllowlist if the package metadata is sufficient.',
      'nested-only@1.0.0 publishes no package-level license evidence; review it and add the exact version to metadataOnlyPackageAllowlist if the package metadata is sufficient.',
      'now-complete@3.0.0 now publishes license or notice text; remove its metadataOnlyPackageAllowlist entry.',
      'removed@1.0.0 is a stale metadataOnlyPackageAllowlist entry.',
    ]);
  });
});
