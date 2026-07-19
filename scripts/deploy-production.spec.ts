import { describe, expect, it, vi } from 'vitest';
import { deployProduction, validateOAuthClientId, wranglerDeployArgs } from './deploy-production.mjs';

describe('production deploy wrapper', () => {
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

  it('passes the validated value to Wrangler without a shell', () => {
    expect(wranglerDeployArgs('oauth-client-id')).toEqual([
      'exec',
      'wrangler',
      'deploy',
      '--var',
      'CLOUDFLARE_OAUTH_CLIENT_ID:oauth-client-id',
    ]);

    const spawn = vi.fn(() => ({ status: 0 }));
    expect(deployProduction({ clientId: 'oauth-client-id', spawn })).toBe(0);
    expect(spawn).toHaveBeenCalledWith(
      'pnpm',
      ['exec', 'wrangler', 'deploy', '--var', 'CLOUDFLARE_OAUTH_CLIENT_ID:oauth-client-id'],
      { stdio: 'inherit' },
    );
  });

  it('propagates process failures', () => {
    expect(() =>
      deployProduction({
        clientId: 'oauth-client-id',
        spawn: () => ({ error: new Error('spawn failed') }),
      }),
    ).toThrow('spawn failed');
    expect(() => deployProduction({ clientId: 'oauth-client-id', spawn: () => ({ status: null }) })).toThrow(
      'Wrangler deploy terminated without an exit status.',
    );
  });
});
