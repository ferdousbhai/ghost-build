import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  GENERATED_PROJECT_DEPENDENCY_POLICY as browserPolicy,
  assertSafeGeneratedPnpmWorkspace,
} from './generatedPnpmWorkspace';
// Exercise the exact template verifier against the same standalone policy source.
// eslint-disable-next-line no-restricted-imports
import {
  GENERATED_PROJECT_DEPENDENCY_POLICY as verifierPolicy,
  findBuildApprovalErrors,
} from '../../template/scripts/lib/project-policy/workspace-policy.mjs';

describe('assertSafeGeneratedPnpmWorkspace', () => {
  test('accepts the canonical generated template policy', () => {
    expect(() =>
      assertSafeGeneratedPnpmWorkspace('pnpm-workspace.yaml', readFileSync('template/pnpm-workspace.yaml', 'utf8')),
    ).not.toThrow();
  });

  test('shares one dependency policy with root and template verification', () => {
    expect(browserPolicy).toEqual(verifierPolicy);
    expect(browserPolicy.profiles.generatedProject.minimumReleaseAgeExclusions).toEqual([]);
    expect(browserPolicy.profiles.repository).toMatchObject({
      minimumReleaseAgeExclusions: ['@cloudflare/computer@0.1.1'],
    });
    expect(browserPolicy.profiles.repository.minimumReleaseAgeExclusionReason).toContain('preview dependency');

    const rootWorkspace = readFileSync('pnpm-workspace.yaml', 'utf8')
      .replace(/^  (?:'@journeyapps\/wa-sqlite'|'@mongodb-js\/zstd'|node-liblzma): false$/gm, '')
      .replace(
        /^patchedDependencies:\n  '@cloudflare\/computer@0\.1\.1': patches\/@cloudflare__computer@0\.1\.1\.patch$/m,
        '',
      );
    expect(findBuildApprovalErrors(rootWorkspace, 'pnpm-workspace.yaml')).toEqual([]);
    expect(findBuildApprovalErrors(readFileSync('template/pnpm-workspace.yaml', 'utf8'), 'template policy')).toEqual(
      [],
    );
  });

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
    safePolicy.replace("  'fast-uri@>=3.0.0 <3.1.5': '3.1.5'", "  'fast-uri@>=3.0.0 <3.1.5': '3.1.4'"),
    safePolicy.replace("  'fast-uri@>=3.0.0 <3.1.5': '3.1.5'\n", ''),
    safePolicy.replace("  'sharp@<0.35.0': '0.35.3'", "  'sharp@<0.35.0': '0.34.5'"),
    safePolicy.replace("  'sharp@<0.35.0': '0.35.3'\n", ''),
    safePolicy.replace(
      "  'fast-uri@>=3.0.0 <3.1.5': '3.1.5'\n",
      "  'fast-uri@>=3.0.0 <3.1.5': '3.1.5'\n  'malicious-package@*': 'file:../outside'\n",
    ),
    `${safePolicy}trustLockfile: true\n`,
    `${safePolicy}minimumReleaseAgeExclude:\n  - malicious-package\n`,
    `${safePolicy}registries:\n  default: https://packages.example.invalid/\n`,
    `${safePolicy}configDependencies:\n  policy: 1.0.0\n`,
    `${safePolicy}"trustLock\\u0066ile": true\n`,
    `${safePolicy}"minimumReleaseAge\\u0045xclude": [malicious-package]\n`,
  ])('rejects dependency cooling-period and lockfile-trust weakening %#', (workspace) => {
    expect(() => assertSafeGeneratedPnpmWorkspace('pnpm-workspace.yaml', workspace)).toThrow(
      /minimumReleaseAge|ignoreWorkspaceRootCheck|project root|blockExoticSubdeps|overrides|trustLockfile|unexpected setting|top-level keys/,
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
  'strictDepBuilds: true\nblockExoticSubdeps: true\noverrides:\n' +
  "  'brace-expansion@<1.1.18': '1.1.18'\n" +
  "  'brace-expansion@>=2.0.0 <2.1.4': '2.1.4'\n" +
  "  'brace-expansion@>=4.0.0 <5.0.9': '5.0.9'\n" +
  "  '@hono/node-server@<2.0.10': '2.0.10'\n" +
  "  'fast-uri@>=3.0.0 <3.1.5': '3.1.5'\n" +
  "  'hono@<4.12.34': '4.12.34'\n" +
  "  'ip-address@<=10.3.0': '10.3.1'\n" +
  "  'postcss@<=8.5.22': '8.5.25'\n" +
  "  'sharp@<0.35.0': '0.35.3'\n" +
  "  'undici@>=7.0.0 <7.29.0': '7.29.0'\n" +
  'allowBuilds:\n  core-js-pure: true\n  esbuild: true\n  sharp: true\n  workerd: true\n';
