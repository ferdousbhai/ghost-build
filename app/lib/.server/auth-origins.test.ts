import { describe, expect, it } from 'vitest';
import { getAuthTrustedOrigins } from './auth-origins';

describe('getAuthTrustedOrigins', () => {
  it('accepts callbacks from the production custom domain and configured Worker origin', () => {
    expect(
      getAuthTrustedOrigins(
        'https://ghostbuild.ferdousbd.workers.dev',
        new Request('https://ghostbuild.dev/api/auth/sign-in/social'),
      ),
    ).toEqual(['https://ghostbuild.ferdousbd.workers.dev', 'https://ghostbuild.dev']);
  });

  it('allows the current request origin for local development', () => {
    expect(getAuthTrustedOrigins(undefined, new Request('http://localhost:5173/api/auth/get-session'))).toEqual([
      'http://localhost:5173',
      'https://ghostbuild.dev',
    ]);
  });
});
