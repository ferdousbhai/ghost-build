import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, test } from 'vitest';

const temporaryDirectories: string[] = [];
const validator = join(process.cwd(), 'sandbox-tools/verify-pnpm-workspace-policy.mjs');
const sandboxToolsPolicy = join(process.cwd(), 'sandbox-tools/pnpm-workspace.yaml');
const safePolicy = `
packages:
  - .
ignoreWorkspaceRootCheck: true
minimumReleaseAge: 1440
minimumReleaseAgeIgnoreMissingTime: false
minimumReleaseAgeStrict: true
strictDepBuilds: true
blockExoticSubdeps: true
allowBuilds:
  core-js-pure: true
  esbuild: true
  sharp: true
  workerd: true
`;

describe('trusted Sandbox pnpm workspace policy', () => {
  test('keeps the sandbox tool installation on the hardened repository policy', async () => {
    const { findWorkspacePolicyErrors } = await import('../sandbox-tools/verify-pnpm-workspace-policy.mjs');

    expect(
      findWorkspacePolicyErrors(readFileSync(sandboxToolsPolicy, 'utf8'), new Set(['esbuild', 'sharp', 'workerd'])),
    ).toEqual([]);
  });

  test('accepts exactly the approved build dependencies', () => {
    expect(validate(safePolicy)).toMatchObject({ status: 0, stderr: '' });
  });

  test.each([
    safePolicy.replace('minimumReleaseAge: 1440', 'minimumReleaseAge: 0'),
    safePolicy.replace('ignoreWorkspaceRootCheck: true', 'ignoreWorkspaceRootCheck: false'),
    safePolicy.replace('  - .', '  - ..'),
    safePolicy.replace('  - .', '  - /tmp/untrusted'),
    safePolicy.replace('  - .', '  - https://packages.example.invalid/project'),
    safePolicy.replace('minimumReleaseAgeIgnoreMissingTime: false', 'minimumReleaseAgeIgnoreMissingTime: true'),
    safePolicy.replace('minimumReleaseAgeStrict: true', 'minimumReleaseAgeStrict: false'),
    safePolicy.replace('blockExoticSubdeps: true', 'blockExoticSubdeps: false'),
    `${safePolicy}\ntrustLockfile: true\n`,
    `${safePolicy}\nminimumReleaseAgeExclude:\n  - malicious-package\n`,
    `${safePolicy}\nregistries:\n  default: https://packages.example.invalid/\n`,
    `${safePolicy}\nconfigDependencies:\n  policy: 1.0.0\n`,
    `${safePolicy}\n"dangerouslyAllow\\u0041llBuilds": true\n`,
    `${safePolicy}\n"trustLock\\u0066ile": true\n`,
    `${safePolicy}\n"minimumReleaseAge\\u0045xclude": [malicious-package]\n`,
    `${safePolicy}\ndangerouslyAllowAllBuilds: false\n`,
    `${safePolicy}  malicious-installer: true\n`,
    `${safePolicy}  esbuild: true\n`,
    `${safePolicy}\nallowBuilds:\n  core-js-pure: true\n  esbuild: true\n  sharp: true\n  workerd: true\n`,
    safePolicy.replace('esbuild: true', 'esbuild: "true"'),
    'strictDepBuilds: true\nallowBuilds: { core-js-pure: true, esbuild: true, sharp: true, workerd: true }\n',
    `${safePolicy}\npolicy: &policy\n  enabled: true\ncopy: *policy\n`,
    `strictDepBuilds: true\ndefaults: &defaults\n  core-js-pure: true\nallowBuilds:\n  <<: *defaults\n  esbuild: true\n  sharp: true\n  workerd: true\n`,
    `${safePolicy}\n"minimumRelease\\u0041ge": 0\n`,
  ])('rejects ambiguous or expanded build-script policy %#', (policy) => {
    const result = validate(policy);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /minimumReleaseAge|ignoreWorkspaceRootCheck|in-tree relative|blockExoticSubdeps|trustLockfile|dangerouslyAllowAllBuilds|unexpected setting|unexpected package|unambiguous YAML|boolean true|anchors|block mapping|top-level keys/,
    );
  });

  test.each([
    '~/.cache/package',
    'C:\\outside',
    '\\\\server\\share',
    ' packages/*',
    'packages/* ',
    'packages//nested',
    '{..,packages}/*',
    '@(../outside|packages)',
  ])('rejects non-canonical or out-of-tree workspace pattern %s', (workspacePackage) => {
    const result = validate(safePolicy.replace('  - .', `  - ${JSON.stringify(workspacePackage)}`));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('in-tree relative workspace patterns');
  });

  test('rejects workspace policy text larger than 64 KiB before parsing', () => {
    const result = validate('x'.repeat(64 * 1024 + 1));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must not exceed 65536 UTF-8 bytes');
  });
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function validate(policy: string): { status: number | null; stderr: string } {
  const directory = mkdtempSync(join(tmpdir(), 'ghostbuild-workspace-policy-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'pnpm-workspace.yaml');
  writeFileSync(path, policy);
  const result = spawnSync(process.execPath, [validator, path], { encoding: 'utf8' });
  return { status: result.status, stderr: result.stderr };
}
