import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  deployAndVerifyProduction,
  deployProduction,
  resolveCurrentCommitSha,
  resolveDeployableCommitSha,
  validateCommitSha,
  validateOAuthClientId,
  wranglerDeployArgs,
} from './deploy-production.mjs';

const commitSha = 'a'.repeat(40);

function expectOrdered(content: string, steps: readonly string[]) {
  let previous = -1;
  for (const step of steps) {
    const index = content.indexOf(step);
    expect(index, `${step} must be present`).toBeGreaterThan(previous);
    previous = index;
  }
}

describe('production deploy wrapper', () => {
  it('runs the clean-tree preflight before every production mutation in manual and CI deploys', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts['deploy:preflight']).toBe('node scripts/deploy-production.mjs --check');
    expectOrdered(packageJson.scripts['deploy:production'], [
      'pnpm run validate',
      'pnpm run deploy:preflight',
      'pnpm run provision:production',
      'pnpm run d1:bookmark:production',
      'pnpm run d1:migrations:apply:production',
      '&& node scripts/deploy-production.mjs',
    ]);

    const workflow = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
    expectOrdered(workflow, [
      'pnpm run validate',
      'git diff --exit-code',
      'node scripts/deploy-production.mjs --check',
      'pnpm run provision:production',
      'pnpm run d1:bookmark:production',
      'pnpm run d1:migrations:apply:production',
      'cloudflare/wrangler-action@',
    ]);
  });

  it('requires a bounded, single-line OAuth client id', () => {
    expect(validateOAuthClientId('oauth-client-id')).toBe('oauth-client-id');
    expect(() => validateOAuthClientId(undefined)).toThrow(
      'CLOUDFLARE_OAUTH_CLIENT_ID must be configured as a non-secret deploy environment variable.',
    );
    expect(() => validateOAuthClientId(' oauth-client-id')).toThrow('may contain only letters');
    expect(() => validateOAuthClientId('oauth\nclient')).toThrow('may contain only letters');
    expect(() => validateOAuthClientId('oauth;client')).toThrow('may contain only letters');
    expect(() => validateOAuthClientId('x'.repeat(513))).toThrow('must be at most 512 characters');
  });

  it('derives and validates the exact current commit', () => {
    expect(validateCommitSha(commitSha)).toBe(commitSha);
    expect(() => validateCommitSha('abc123')).toThrow('exact lowercase 40-hex');
    expect(() => validateCommitSha('A'.repeat(40))).toThrow('exact lowercase 40-hex');
    expect(
      resolveCurrentCommitSha({
        spawn: vi.fn(() => ({ status: 0, stdout: `${commitSha}\n`, stderr: '' })) as never,
      }),
    ).toBe(commitSha);
    expect(() =>
      resolveCurrentCommitSha({
        spawn: vi.fn(() => ({ status: 128, stdout: '', stderr: 'not a repository' })) as never,
      }),
    ).toThrow('Unable to resolve the current Git commit: not a repository');

    const cleanSpawn = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: `${commitSha}\n`, stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });
    expect(resolveDeployableCommitSha({ spawn: cleanSpawn as never })).toBe(commitSha);
    expect(cleanSpawn).toHaveBeenLastCalledWith(
      'git',
      [
        'ls-files',
        '--others',
        '--ignored',
        '--exclude-standard',
        '-z',
        '--',
        ':(top).env',
        ':(top).env.*',
        ':(top).dev.vars',
        ':(top).dev.vars*',
        ':(top)*.vars',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const dirtySpawn = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: `${commitSha}\n`, stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: ' M app/server.ts\n', stderr: '' });
    expect(() => resolveDeployableCommitSha({ spawn: dirtySpawn as never })).toThrow(
      'Production deploy requires a clean Git worktree',
    );

    const ignoredEnvSpawn = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: `${commitSha}\n`, stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: '.env.production\0', stderr: '' });
    expect(() => resolveDeployableCommitSha({ spawn: ignoredEnvSpawn as never })).toThrow(
      'Production deploy refuses ignored root .env*, .dev.vars*, and *.vars files',
    );
  });

  it('passes the OAuth ID and exact commit to Wrangler without a shell', () => {
    expect(wranglerDeployArgs('oauth-client-id', commitSha)).toEqual([
      'exec',
      'wrangler',
      'deploy',
      '--var',
      `COMMIT_SHA:${commitSha}`,
      '--var',
      'CLOUDFLARE_OAUTH_CLIENT_ID:oauth-client-id',
    ]);

    const spawn = vi.fn(() => ({ status: 0 }));
    expect(deployProduction({ clientId: 'oauth-client-id', commitSha, spawn })).toBe(commitSha);
    expect(spawn).toHaveBeenCalledWith(
      'pnpm',
      [
        'exec',
        'wrangler',
        'deploy',
        '--var',
        `COMMIT_SHA:${commitSha}`,
        '--var',
        'CLOUDFLARE_OAUTH_CLIENT_ID:oauth-client-id',
      ],
      { stdio: 'inherit' },
    );
  });

  it('verifies the local and global deployment against the deployed commit', async () => {
    const verifyLocal = vi.fn(async () => undefined);
    const verifyGlobal = vi.fn(async () => undefined);

    await expect(
      deployAndVerifyProduction({
        clientId: 'oauth-client-id',
        commitSha,
        spawn: () => ({ status: 0 }),
        verifyLocal,
        verifyGlobal,
      }),
    ).resolves.toBe(commitSha);
    expect(verifyLocal).toHaveBeenCalledWith({ expectedSha: commitSha });
    expect(verifyGlobal).toHaveBeenCalledWith({ expectedSha: commitSha });
    expect(verifyLocal.mock.invocationCallOrder[0]).toBeLessThan(verifyGlobal.mock.invocationCallOrder[0]);
  });

  it('propagates process failures', () => {
    expect(() =>
      deployProduction({
        clientId: 'oauth-client-id',
        commitSha,
        spawn: () => ({ error: new Error('spawn failed') }),
      }),
    ).toThrow('spawn failed');
    expect(() => deployProduction({ clientId: 'oauth-client-id', commitSha, spawn: () => ({ status: null }) })).toThrow(
      'Wrangler deploy terminated without an exit status.',
    );
    expect(() => deployProduction({ clientId: 'oauth-client-id', commitSha, spawn: () => ({ status: 23 }) })).toThrow(
      'Wrangler deploy failed with exit status 23. Live verification was not run.',
    );
  });
});
