import { createCollection } from '@tanstack/db';
import { queryCollectionOptions } from '@tanstack/query-db-collection';
import { useLiveQuery } from '@tanstack/react-db';
import { useCallback } from 'react';
import { z } from 'zod';
import { executeDataOperation } from './client';
import { api, type ChatHistorySummary } from './data-api';
import { queryClient } from '~/lib/stores/reactQueryClient';
import { loadAllChatHistory } from './data-page-loader';
import {
  ACCOUNT_LOCAL_REPLICA_SCHEMA_VERSION,
  ACCOUNT_LOCAL_REPLICA_GC_TIME,
  registerAccountCollectionDisposer,
  type AccountLocalReplica,
  useAccountLocalReplica,
} from './account-local-replica';
import { useQueryCacheError } from './use-query-cache-error';

const chatHistorySummarySchema = z.object({
  id: z.string().min(1),
  initialId: z.string().min(1),
  description: z.string().optional(),
  timestamp: z.iso.datetime(),
}) satisfies z.ZodType<ChatHistorySummary>;

function chatHistoryQueryKey(sessionId: string) {
  return ['ghostbuild-data', api.messages.getAll, { sessionId }] as const;
}

function createChatHistoryCollection(sessionId: string, replica: AccountLocalReplica | null) {
  const queryOptions = queryCollectionOptions({
    id: `projects`,
    schema: chatHistorySummarySchema,
    queryKey: chatHistoryQueryKey(sessionId),
    queryClient,
    queryFn: ({ signal }) => loadAllChatHistory(sessionId, signal),
    getKey: (item) => item.initialId,
    persistedGcTime: ACCOUNT_LOCAL_REPLICA_GC_TIME,
    onDelete: async ({ transaction }) => {
      await Promise.all(
        transaction.mutations.map((mutation) =>
          executeDataOperation(api.messages.remove, { id: mutation.key, sessionId }),
        ),
      );
    },
  });
  if (!replica) {
    return createCollection(queryOptions);
  }
  return createCollection({
    ...replica.persistedCollectionOptions({
      ...queryOptions,
      persistence: replica.persistence,
      schemaVersion: ACCOUNT_LOCAL_REPLICA_SCHEMA_VERSION,
    }),
    // Preserve required-schema inference across the persistence wrapper's
    // currently optional CollectionConfig schema declaration.
    schema: chatHistorySummarySchema,
  });
}

type ChatHistoryCollection = ReturnType<typeof createChatHistoryCollection>;

const chatHistoryCollections = new Map<string, ChatHistoryCollection>();
const activeChatHistoryCollections = new Map<string, ChatHistoryCollection>();

registerAccountCollectionDisposer(async () => {
  const collections = new Set(chatHistoryCollections.values());
  chatHistoryCollections.clear();
  activeChatHistoryCollections.clear();
  await Promise.allSettled([...collections].map((collection) => collection.cleanup()));
});

function getChatHistoryCollection(sessionId: string, replica: AccountLocalReplica | null) {
  const cacheKey = `${sessionId}:${replica ? 'persisted' : 'memory'}`;
  const existing = chatHistoryCollections.get(cacheKey);
  if (existing) {
    activeChatHistoryCollections.set(sessionId, existing);
    return existing;
  }

  const collection = createChatHistoryCollection(sessionId, replica);
  chatHistoryCollections.set(cacheKey, collection);
  activeChatHistoryCollections.set(sessionId, collection);
  return collection;
}

export function useChatHistory(sessionId: string | null | undefined) {
  const replica = useAccountLocalReplica(sessionId);
  const collection = sessionId && replica !== undefined ? getChatHistoryCollection(sessionId, replica) : undefined;
  const query = useLiveQuery(() => collection, [collection]);
  const error = useQueryCacheError(sessionId ? chatHistoryQueryKey(sessionId) : undefined);
  const retry = useCallback(() => {
    void collection?.utils.clearError().catch(() => undefined);
  }, [collection]);
  return {
    projects: query.data ?? [],
    isLoading: replica === undefined || query.isLoading,
    error,
    retry,
  };
}

export async function removeChatHistoryItem(sessionId: string, initialId: string) {
  const collection = activeChatHistoryCollections.get(sessionId) ?? getChatHistoryCollection(sessionId, null);
  const tx = collection.delete(initialId, {
    metadata: { source: 'sidebar' },
  });
  await tx.isPersisted.promise;
}

export function refreshChatHistory(sessionId: string) {
  return queryClient.invalidateQueries({ queryKey: chatHistoryQueryKey(sessionId) });
}
