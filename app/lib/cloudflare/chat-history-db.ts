import { createCollection } from '@tanstack/db';
import { queryCollectionOptions } from '@tanstack/query-db-collection';
import { useLiveQuery } from '@tanstack/react-db';
import { z } from 'zod';
import { executeDataOperation } from './client';
import { api, type ChatHistorySummary } from './data-api';
import { queryClient } from '~/lib/stores/reactQueryClient';
import { loadAllChatHistory } from './data-page-loader';
import {
  ACCOUNT_LOCAL_REPLICA_SCHEMA_VERSION,
  type AccountLocalReplica,
  useAccountLocalReplica,
} from './account-local-replica';

const chatHistorySummarySchema = z.object({
  id: z.string().min(1),
  initialId: z.string().min(1),
  description: z.string().optional(),
  timestamp: z.iso.datetime(),
}) satisfies z.ZodType<ChatHistorySummary>;

function createChatHistoryCollection(sessionId: string, replica: AccountLocalReplica | null) {
  const queryOptions = queryCollectionOptions({
    id: `projects`,
    schema: chatHistorySummarySchema,
    queryKey: ['ghostbuild-data', 'messages.getAll', { sessionId }],
    queryClient,
    queryFn: ({ signal }) => loadAllChatHistory(sessionId, signal),
    getKey: (item) => item.initialId,
    persistedGcTime: Number.POSITIVE_INFINITY,
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
  const { data = [] } = useLiveQuery(() => collection, [collection]);
  return data;
}

export async function removeChatHistoryItem(sessionId: string, initialId: string) {
  const collection = activeChatHistoryCollections.get(sessionId) ?? getChatHistoryCollection(sessionId, null);
  const tx = collection.delete(initialId, {
    metadata: { source: 'sidebar' },
  });
  await tx.isPersisted.promise;
}

export function refreshChatHistory(sessionId: string) {
  return queryClient.invalidateQueries({ queryKey: ['ghostbuild-data', 'messages.getAll', { sessionId }] });
}
