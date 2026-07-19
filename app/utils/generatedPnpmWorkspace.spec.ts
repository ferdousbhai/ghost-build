import { describe, expect, test } from 'vitest';
import { assertSafeGeneratedPnpmWorkspace } from './generatedPnpmWorkspace';

describe('assertSafeGeneratedPnpmWorkspace', () => {
  test('accepts the canonical cooling period and explicit dependency build approvals', () => {
    expect(() => assertSafeGeneratedPnpmWorkspace('pnpm-workspace.yaml', safePolicy)).not.toThrow();
  });

  test.each([
    safePolicy.replace('minimumReleaseAge: 1440', 'minimumReleaseAge: 0'),
    safePolicy.replace('ignoreWorkspaceRootCheck: true', 'ignoreWorkspaceRootCheck: false'),
    safePolicy.replace('  - .', '  - ..'),
    safePolicy.replace('  - .', '  - /tmp/untrusted'),
    safePolicy.replace('minimumReleaseAgeIgnoreMissingTime: false', 'minimumReleaseAgeIgnoreMissingTime: true'),
    safePolicy.replace('minimumReleaseAgeStrict: true', 'minimumReleaseAgeStrict: false'),
    safePolicy.replace('blockExoticSubdeps: true', 'blockExoticSubdeps: false'),
    `${safePolicy}trustLockfile: true\n`,
    `${safePolicy}minimumReleaseAgeExclude:\n  - malicious-package\n`,
    `${safePolicy}registries:\n  default: https://packages.example.invalid/\n`,
    `${safePolicy}configDependencies:\n  policy: 1.0.0\n`,
    `${safePolicy}"trustLock\\u0066ile": true\n`,
    `${safePolicy}"minimumReleaseAge\\u0045xclude": [malicious-package]\n`,
  ])('rejects dependency cooling-period and lockfile-trust weakening %#', (workspace) => {
    expect(() => assertSafeGeneratedPnpmWorkspace('pnpm-workspace.yaml', workspace)).toThrow(
      /minimumReleaseAge|ignoreWorkspaceRootCheck|project root|blockExoticSubdeps|trustLockfile|unexpected setting|top-level keys/,
    );
  });

  test.each([
    'dangerouslyAllowAllBuilds: true',
    '  dangerouslyAllowAllBuilds: FALSE # explicit bypass setting',
    '"dangerouslyAllowAllBuilds": true',
    '"dangerouslyAllow\\u0041llBuilds": true',
  ])('rejects the global lifecycle-script bypass: %s', (workspace) => {
    expect(() => assertSafeGeneratedPnpmWorkspace('./pnpm-workspace.yaml', workspace)).toThrow(
      'must not define dangerouslyAllowAllBuilds',
    );
  });

  test('rejects an unreviewed lifecycle-script approval', () => {
    expect(() =>
      assertSafeGeneratedPnpmWorkspace('pnpm-workspace.yaml', `${safePolicy}  malicious-installer: true\n`),
    ).toThrow('must not approve unexpected package malicious-installer');
  });

  test.each([
    'strictDepBuilds: true\nstrictDepBuilds: true\nallowBuilds:\n  core-js-pure: true\n  esbuild: true\n  sharp: true\n  workerd: true\n',
    'strictDepBuilds: true\nallowBuilds:\n  core-js-pure: true\n  esbuild: true\n  sharp: true\n  workerd: true\nallowBuilds:\n  core-js-pure: true\n  esbuild: true\n  sharp: true\n  workerd: true\n',
    'strictDepBuilds: true\nallowBuilds:\n  core-js-pure: true\n  esbuild: true\n  esbuild: true\n  sharp: true\n  workerd: true\n',
    'strictDepBuilds: true\nallowBuilds: &approved\n  core-js-pure: true\n  esbuild: true\n  sharp: true\n  workerd: true\ncopy: *approved\n',
    'strictDepBuilds: true\nbase: &approved\n  core-js-pure: true\nallowBuilds:\n  <<: *approved\n  esbuild: true\n  sharp: true\n  workerd: true\n',
    'strictDepBuilds: true\nallowBuilds:\n  core-js-pure: true\n  esbuild: "true"\n  sharp: true\n  workerd: true\n',
    'strictDepBuilds: true\nallowBuilds: { core-js-pure: true, esbuild: true, sharp: true, workerd: true }\n',
    'minimumReleaseAge: 1440\n"minimumRelease\\u0041ge": 0\nminimumReleaseAgeStrict: true\nstrictDepBuilds: true\nallowBuilds:\n  core-js-pure: true\n  esbuild: true\n  sharp: true\n  workerd: true\n',
    'minimumReleaseAge: 1440\nminimumReleaseAgeStrict: true\nstrictDepBuilds: true\nallowBuilds:\n  core-js-pure: true\n  esbuild: !!bool true\n  sharp: true\n  workerd: true\n',
  ])('rejects ambiguous or non-boolean policy constructs %#', (workspace) => {
    expect(() => assertSafeGeneratedPnpmWorkspace('pnpm-workspace.yaml', workspace)).toThrow();
  });

  test('rejects policy text larger than 64 KiB before parsing', () => {
    expect(() => assertSafeGeneratedPnpmWorkspace('pnpm-workspace.yaml', 'x'.repeat(64 * 1024 + 1))).toThrow(
      'must not exceed 65536 UTF-8 bytes',
    );
  });
});

const safePolicy =
  'packages:\n  - .\nignoreWorkspaceRootCheck: true\nminimumReleaseAge: 1440\n' +
  'minimumReleaseAgeIgnoreMissingTime: false\nminimumReleaseAgeStrict: true\n' +
  'strictDepBuilds: true\nblockExoticSubdeps: true\nallowBuilds:\n' +
  '  core-js-pure: true\n  esbuild: true\n  sharp: true\n  workerd: true\n';
