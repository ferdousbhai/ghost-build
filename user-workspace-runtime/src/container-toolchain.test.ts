import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { GENERATED_PROJECT_PNPM_VERSION } from '../../ghostbuild-agent/cloudflare-computer';
import {
  COMPUTERD_BINARY,
  computerdBootstrapCommand,
  containerToolchainBootstrapCommand,
  strictSubshellCommand,
} from './container-toolchain';

describe('container toolchain bootstrap', () => {
  it('installs and verifies the pinned pnpm version missing from the stock Sandbox image', () => {
    const command = containerToolchainBootstrapCommand();

    expect(command).toMatch(/^\(\nset -eu\n[\s\S]+\n\)$/);
    expect(command).toContain('command -v pnpm');
    expect(command).toContain(`npm install --global pnpm@${GENERATED_PROJECT_PNPM_VERSION}`);
    expect(command).toContain(`test "$(pnpm --version)" = '${GENERATED_PROJECT_PNPM_VERSION}'`);
    expect(command).toContain('--ignore-scripts');
    expect(command).toContain('--registry=https://registry.npmjs.org/');
  });

  it('installs computerd without probing through a failing Sandbox exec', () => {
    const command = computerdBootstrapCommand();

    expect(command).toMatch(/^\(\nset -eu\n[\s\S]+\n\)$/);
    expect(command).toContain(`if [ ! -x '${COMPUTERD_BINARY}' ]; then`);
    expect(command).toContain('ghcr.io/v2/cloudflare/computer-computerd-linux-x64/blobs/sha256:');
    expect(command).toContain(`test -x '${COMPUTERD_BINARY}'`);
  });

  it('keeps strict shell flags inside the bootstrap command', () => {
    const parent = spawnSync('/bin/sh', ['-c', `${strictSubshellCommand(['true'])}\nfalse\nprintf survived`], {
      encoding: 'utf8',
    });
    const child = spawnSync('/bin/sh', ['-c', strictSubshellCommand(['false', 'printf leaked'])], {
      encoding: 'utf8',
    });

    expect(parent.status).toBe(0);
    expect(parent.stdout).toBe('survived');
    expect(child.status).not.toBe(0);
    expect(child.stdout).toBe('');
  });
});
