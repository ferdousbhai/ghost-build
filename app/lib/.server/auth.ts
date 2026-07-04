import { betterAuth } from 'better-auth';
import { tanstackStartCookies } from 'better-auth/tanstack-start';

import { getOptionalBinding } from './env';

function requireBinding(env: Env, name: 'BETTER_AUTH_SECRET' | 'GOOGLE_CLIENT_ID' | 'GOOGLE_CLIENT_SECRET') {
  const value = getOptionalBinding(env, name);
  if (!value) {
    throw new Error(`Cloudflare binding ${name} is not configured`);
  }
  return value;
}

function getBaseURL(env: Env, request?: Request) {
  return (
    getOptionalBinding(env, 'BETTER_AUTH_URL') ??
    getOptionalBinding(env, 'CLOUDFLARE_SITE_URL') ??
    (request ? new URL(request.url).origin : undefined)
  );
}

export function getAuth(env: Env, request?: Request) {
  if (!env.DB) {
    throw new Error('Cloudflare D1 binding DB is not configured');
  }

  return betterAuth({
    appName: 'Ghostbuild',
    baseURL: getBaseURL(env, request),
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
    socialProviders: {
      google: {
        clientId: requireBinding(env, 'GOOGLE_CLIENT_ID'),
        clientSecret: requireBinding(env, 'GOOGLE_CLIENT_SECRET'),
      },
    },
    plugins: [tanstackStartCookies()],
  });
}
