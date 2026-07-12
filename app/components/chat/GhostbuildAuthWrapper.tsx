import { createContext, useContext, useEffect, useLayoutEffect } from 'react';

import { authClient, signInWithGoogle } from '~/lib/auth-client';
import { sessionIdStore, useSessionIdOrNullOrLoading } from '~/lib/stores/sessionId';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { executeDataOperation } from '~/lib/cloudflare/client';
import { api } from '~/lib/cloudflare/data-api';
import { getOrCreateGuestSessionId, getStoredGuestSessionId, isGuestSessionId } from '~/lib/guest-session';

const logger = createScopedLogger('GhostbuildAuth');
const claimedGuestSessionIds = new Set<string>();
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

type GhostbuildAuthState =
  | {
      kind: 'loading';
    }
  | {
      kind: 'unauthenticated';
    }
  | {
      kind: 'guest';
      sessionId: string;
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
  allowGuest = false,
}: {
  children: React.ReactNode;
  redirectIfUnauthenticated: boolean;
  allowGuest?: boolean;
}) => {
  const sessionId = useSessionIdOrNullOrLoading();
  const { data: authSession, isPending } = authClient.useSession();
  const userId = authSession?.user.id ?? null;

  useIsomorphicLayoutEffect(() => {
    if (isPending) {
      sessionIdStore.set(allowGuest ? getOrCreateGuestSessionId() : undefined);
      return;
    }

    if (userId) {
      const guestSessionId = getStoredGuestSessionId();
      sessionIdStore.set(userId);
      if (guestSessionId && !claimedGuestSessionIds.has(guestSessionId)) {
        claimedGuestSessionIds.add(guestSessionId);
        void executeDataOperation(api.messages.claimGuestSession, {
          guestSessionId,
          sessionId: userId,
        }).catch((error) => {
          claimedGuestSessionIds.delete(guestSessionId);
          logger.warn('Failed to claim guest session', error);
        });
      }
      return;
    }

    sessionIdStore.set(allowGuest ? getOrCreateGuestSessionId() : null);
  }, [allowGuest, isPending, userId]);

  const isAuthLoading = sessionId === undefined || (!allowGuest && isPending);
  const state: GhostbuildAuthState = isAuthLoading
    ? { kind: 'loading' }
    : userId
      ? { kind: 'fullyLoggedIn', sessionId: userId }
      : allowGuest && isGuestSessionId(sessionId)
        ? { kind: 'guest', sessionId }
        : { kind: 'unauthenticated' };

  useEffect(() => {
    if (redirectIfUnauthenticated && state.kind === 'unauthenticated') {
      logger.debug('Redirecting unauthenticated user to /');
      void signInWithGoogle(window.location.href);
    }
  }, [redirectIfUnauthenticated, state.kind]);

  return <GhostbuildAuthContext.Provider value={{ state }}>{children}</GhostbuildAuthContext.Provider>;
};
