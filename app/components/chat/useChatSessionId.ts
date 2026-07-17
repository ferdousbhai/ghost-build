import { useSessionIdOrNullOrLoading } from '~/lib/stores/sessionId';

export function useChatSessionId(): string | null | undefined {
  return useSessionIdOrNullOrLoading();
}
