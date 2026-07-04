import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({
  basePath: '/api/auth',
});

export function signInWithGoogle(callbackURL = window.location.href) {
  return authClient.signIn.social({
    provider: 'google',
    callbackURL,
  });
}

export async function signOutOfGhostbuild(callbackURL = window.location.origin) {
  await authClient.signOut();
  window.location.href = callbackURL;
}
