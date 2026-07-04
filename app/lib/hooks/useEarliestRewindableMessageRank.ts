import { useQuery } from '~/lib/cloudflare/data-hooks';
import { api } from '~/lib/cloudflare/data-api';
import { useSessionIdOrNullOrLoading } from '~/lib/stores/sessionId';
import { chatIdStore } from '~/lib/stores/chatId';

export function useEarliestRewindableMessageRank(): number | null | undefined {
  const sessionId = useSessionIdOrNullOrLoading();
  const chatId = chatIdStore.get();

  return useQuery(
    api.messages.earliestRewindableMessageRank,
    sessionId && chatId
      ? {
          sessionId,
          chatId,
        }
      : 'skip',
  );
}
