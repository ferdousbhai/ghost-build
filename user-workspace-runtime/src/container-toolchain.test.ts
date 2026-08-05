import { describe, expect, it } from 'vitest';
import { GENERATED_PROJECT_PNPM_VERSION } from '../../ghostbuild-agent/cloudflare-computer';
import { containerToolchainBootstrapCommand } from './container-toolchain';

describe('container toolchain bootstrap', () => {
  it('installs and verifies the pinned pnpm version missing from the stock Sandbox image', () => {
    const command = containerToolchainBootstrapCommand();

    expect(command).toContain('command -v pnpm');
    expect(command).toContain(`npm install --global pnpm@${GENERATED_PROJECT_PNPM_VERSION}`);
    expect(command).toContain(`test "$(pnpm --version)" = '${GENERATED_PROJECT_PNPM_VERSION}'`);
    expect(command).toContain('--ignore-scripts');
    expect(command).toContain('--registry=https://registry.npmjs.org/');
  });
});
