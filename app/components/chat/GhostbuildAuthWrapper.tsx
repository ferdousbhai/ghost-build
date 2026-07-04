import { createContext, useContext, useEffect } from 'react';

import { authClient, signInWithGoogle } from '~/lib/auth-client';
import { sessionIdStore, useSessionIdOrNullOrLoading } from '~/lib/stores/sessionId';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';

const logger = createScopedLogger('GhostbuildAuth');

type GhostbuildAuthState =
  | {
      kind: 'loading';
    }
  | {
      kind: 'unauthenticated';
    }
  | {
      kind: 'fullyLoggedIn';
      sessionId: string;
    };

const GhostbuildAuthContext = createContext<{
  state: GhostbuildAuthState;
} | null>(null);

export function useGhostbuildAuth() {
  const context = useContext(GhostbuildAuthContext);
  if (context === null) {
    throw new Error('useGhostbuildAuth must be used within a GhostbuildAuthProvider');
  }
  return context.state;
}

export const GhostbuildAuthProvider = ({
  children,
  redirectIfUnauthenticated,
}: {
  children: React.ReactNode;
  redirectIfUnauthenticated: boolean;
}) => {
  const sessionId = useSessionIdOrNullOrLoading();
  const { data: authSession, isPending } = authClient.useSession();
  const userId = authSession?.user.id ?? null;

  useEffect(() => {
    if (isPending) {
      sessionIdStore.set(undefined);
      return;
    }

    sessionIdStore.set(userId);
  }, [isPending, userId]);

  const isAuthLoading = sessionId === undefined || isPending;
  const isUnauthenticated = sessionId === null || !userId;
  const state: GhostbuildAuthState = isAuthLoading
    ? { kind: 'loading' }
    : isUnauthenticated
      ? { kind: 'unauthenticated' }
      : { kind: 'fullyLoggedIn', sessionId: sessionId as string };

  useEffect(() => {
    if (redirectIfUnauthenticated && state.kind === 'unauthenticated') {
      logger.debug('Redirecting unauthenticated user to /');
      void signInWithGoogle(window.location.href);
    }
  }, [redirectIfUnauthenticated, state.kind]);

  return <GhostbuildAuthContext.Provider value={{ state }}>{children}</GhostbuildAuthContext.Provider>;
};
