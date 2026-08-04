import { createContext, useContext, useEffect, useLayoutEffect } from 'react';
import { authClient } from '~/lib/auth-client';
import { sessionIdStore, useSessionIdOrNullOrLoading } from '~/lib/stores/sessionId';

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

type GhostbuildAuthState =
  { kind: 'loading' } | { kind: 'unauthenticated' } | { kind: 'fullyLoggedIn'; sessionId: string };

const GhostbuildAuthContext = createContext<{ state: GhostbuildAuthState } | null>(null);

export function useGhostbuildAuth() {
  const context = useContext(GhostbuildAuthContext);
  if (context === null) {
    throw new Error('useGhostbuildAuth must be used within a GhostbuildAuthProvider');
  }
  return context.state;
}

export function GhostbuildAuthProvider({ children }: { children: React.ReactNode }) {
  const sessionId = useSessionIdOrNullOrLoading();
  const { data: authSession, isPending } = authClient.useSession();
  const userId = authSession?.user.id ?? null;

  useIsomorphicLayoutEffect(() => {
    sessionIdStore.set(isPending ? undefined : userId);
  }, [isPending, userId]);

  const state: GhostbuildAuthState =
    isPending || sessionId === undefined
      ? { kind: 'loading' }
      : userId
        ? { kind: 'fullyLoggedIn', sessionId: userId }
        : { kind: 'unauthenticated' };

  return <GhostbuildAuthContext.Provider value={{ state }}>{children}</GhostbuildAuthContext.Provider>;
}
