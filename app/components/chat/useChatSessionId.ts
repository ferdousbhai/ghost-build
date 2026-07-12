import { getOrCreateGuestSessionId } from '~/lib/guest-session';
import { sessionIdStore, useSessionIdOrNullOrLoading } from '~/lib/stores/sessionId';

export function useChatSessionId(allowGuest: boolean): string | null | undefined {
  const sessionId = useSessionIdOrNullOrLoading();
  if (typeof sessionId === 'string') {
    return sessionId;
  }

  const guestSessionId = allowGuest && typeof window !== 'undefined' ? getOrCreateGuestSessionId() : null;
  if (guestSessionId && sessionIdStore.get() !== guestSessionId) {
    sessionIdStore.set(guestSessionId);
  }
  return guestSessionId ?? sessionId;
}
