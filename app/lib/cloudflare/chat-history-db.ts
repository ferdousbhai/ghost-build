import { createCollection } from '@tanstack/db';
import { queryCollectionOptions } from '@tanstack/query-db-collection';
import { useLiveQuery } from '@tanstack/react-db';
import { executeDataOperation } from './client';
import { api, type ChatHistorySummary } from './data-api';
import { queryClient } from '~/lib/stores/reactQueryClient';

function createChatHistoryCollection(sessionId: string) {
  return createCollection(
    queryCollectionOptions<ChatHistorySummary>({
      id: `chat-history:${sessionId}`,
      queryKey: ['ghostbuild-data', 'messages.getAll', { sessionId }],
      queryClient,
      queryFn: () => executeDataOperation(api.messages.getAll, { sessionId }),
      getKey: (item) => item.id,
      onDelete: async ({ transaction }) => {
        await Promise.all(
          transaction.mutations.map((mutation) =>
            executeDataOperation(api.messages.remove, { id: mutation.key, sessionId }),
          ),
        );
      },
    }),
  );
}

type ChatHistoryCollection = ReturnType<typeof createChatHistoryCollection>;

const chatHistoryCollections = new Map<string, ChatHistoryCollection>();

function getChatHistoryCollection(sessionId: string) {
  const existing = chatHistoryCollections.get(sessionId);
  if (existing) {
    return existing;
  }

  const collection = createChatHistoryCollection(sessionId);
  chatHistoryCollections.set(sessionId, collection);
  return collection;
}

export function useChatHistory(sessionId: string | null | undefined) {
  const collection = sessionId ? getChatHistoryCollection(sessionId) : undefined;
  const { data = [] } = useLiveQuery(() => collection, [collection]);
  return data;
}

export async function removeChatHistoryItem(sessionId: string, itemId: string) {
  const collection = getChatHistoryCollection(sessionId);
  const tx = collection.delete(itemId, {
    metadata: { source: 'sidebar' },
  });
  await tx.isPersisted.promise;
}
