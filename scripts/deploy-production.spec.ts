import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import {
  deployAndVerifyProduction,
  deployProduction,
  resolveCurrentCommitSha,
  resolveDeployableCommitSha,
  validateCommitSha,
  validateOAuthClientId,
  validateWorkersBuildContext,
  validateWorkersBuildMetadata,
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
  it('keeps manual and Workers Builds releases on the same ordered production path', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts['deploy:preflight']).toBe('node scripts/deploy-production.mjs --check');
    expectOrdered(packageJson.scripts['deploy:production'], ['pnpm run validate', 'pnpm run release:production']);
    expectOrdered(packageJson.scripts['release:production'], [
      'pnpm run deploy:preflight',
      'pnpm run provision:production:check',
      'pnpm run verify:production-config',
      'pnpm run verify:workers-builds-config',
      'pnpm run d1:bookmark:production',
      'pnpm run d1:migrations:apply:production',
      '&& node scripts/deploy-production.mjs',
    ]);
    expect(packageJson.scripts['workers-builds:deploy']).toContain(
      'node scripts/deploy-production.mjs --check-workers-builds && pnpm run release:production',
    );
    expect(existsSync(new URL('../.github/workflows/deploy.yml', import.meta.url))).toBe(false);
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
    expect(resolveDeployableCommitSha({ spawn: cleanSpawn as never, env: {} })).toBe(commitSha);
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
    expect(() => resolveDeployableCommitSha({ spawn: dirtySpawn as never, env: {} })).toThrow(
      'Production deploy requires a clean Git worktree',
    );

    const ignoredEnvSpawn = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: `${commitSha}\n`, stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: '.env.production\0', stderr: '' });
    expect(() => resolveDeployableCommitSha({ spawn: ignoredEnvSpawn as never, env: {} })).toThrow(
      'Production deploy refuses ignored root .env*, .dev.vars*, and *.vars files',
    );
  });

  it('binds Workers Builds releases to main, the exact checkout, and a build UUID', () => {
    const env = {
      WORKERS_CI: '1',
      WORKERS_CI_BRANCH: 'main',
      WORKERS_CI_BUILD_UUID: '11111111-2222-3333-8444-555555555555',
      WORKERS_CI_COMMIT_SHA: commitSha,
    };
    expect(
      validateWorkersBuildMetadata({
        env: { ...env, WORKERS_CI_BRANCH: 'feature/cloudflare-preview' },
        currentCommitSha: commitSha,
      }),
    ).toEqual({ branch: 'feature/cloudflare-preview', commitSha });
    expect(
      validateWorkersBuildContext({
        env,
        spawn: vi.fn(() => ({ status: 0, stdout: `${commitSha}\n`, stderr: '' })) as never,
      }),
    ).toBe(commitSha);
    expect(() =>
      validateWorkersBuildContext({
        env: { ...env, WORKERS_CI_BRANCH: 'feature' },
        currentCommitSha: commitSha,
      }),
    ).toThrow('requires the main branch');
    expect(() =>
      validateWorkersBuildContext({
        env: { ...env, WORKERS_CI_COMMIT_SHA: 'b'.repeat(40) },
        currentCommitSha: commitSha,
      }),
    ).toThrow('does not match the checked-out commit');
    expect(() =>
      validateWorkersBuildContext({
        env: { ...env, WORKERS_CI_BUILD_UUID: 'not-a-uuid' },
        currentCommitSha: commitSha,
      }),
    ).toThrow('must be a lowercase UUID');
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
