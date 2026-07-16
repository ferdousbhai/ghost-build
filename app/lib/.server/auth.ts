import { betterAuth } from 'better-auth';
import { tanstackStartCookies } from 'better-auth/tanstack-start';

import { getOptionalBinding } from './env';
import { getAuthTrustedOrigins } from './auth-origins';

function requireBinding(env: Env, name: 'BETTER_AUTH_SECRET' | 'GOOGLE_CLIENT_ID' | 'GOOGLE_CLIENT_SECRET') {
  const value = getOptionalBinding(env, name);
  if (!value) {
    throw new Error(`Cloudflare binding ${name} is not configured`);
  }
  return value;
}

function getBaseURL(env: Env, request?: Request) {
  return getOptionalBinding(env, 'BETTER_AUTH_URL') ?? (request ? new URL(request.url).origin : undefined);
}

export function getAuth(env: Env, request?: Request) {
  if (!env.DB) {
    throw new Error('Cloudflare D1 binding DB is not configured');
  }

  const baseURL = getBaseURL(env, request);
  return betterAuth({
    appName: 'Ghostbuild',
    baseURL,
    trustedOrigins: getAuthTrustedOrigins(baseURL, request),
    secret: requireBinding(env, 'BETTER_AUTH_SECRET'),
    onAPIError: {
      onError(error) {
        console.error('Better Auth API error', {
          name: error instanceof Error ? error.name : undefined,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          status: typeof error === 'object' && error && 'status' in error ? error.status : undefined,
          body: typeof error === 'object' && error && 'body' in error ? error.body : undefined,
        });
      },
    },
    database: env.DB,
    account: {
      // OAuth initiation must not depend on a D1 write completing. Better Auth
      // encrypts and authenticates this short-lived state cookie with the app
      // secret, while still enforcing the state-cookie check on callback.
      storeStateStrategy: 'cookie',
    },
    socialProviders: {
      google: {
        clientId: requireBinding(env, 'GOOGLE_CLIENT_ID'),
        clientSecret: requireBinding(env, 'GOOGLE_CLIENT_SECRET'),
      },
    },
    plugins: [tanstackStartCookies()],
  });
}
