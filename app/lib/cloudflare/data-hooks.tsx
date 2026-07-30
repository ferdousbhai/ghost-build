import { skipToken, useMutation as useTanStackMutation, useQuery as useTanStackQuery } from '@tanstack/react-query';
import { createCollection } from '@tanstack/db';
import { queryCollectionOptions } from '@tanstack/query-db-collection';
import { useLiveQuery } from '@tanstack/react-db';
import { z } from 'zod';
import { transcriptIdentitySchema } from 'ghostbuild-agent/transcript';
import { executeDataOperation } from './client';
import {
  api,
  type DataOperationArgs,
  type DataOperationPath,
  type DataOperationResult,
  type SubchatSummary,
} from './data-api';
import { loadAllSubchats } from './data-page-loader';
import { queryClient } from '~/lib/stores/reactQueryClient';
import {
  ACCOUNT_LOCAL_REPLICA_SCHEMA_VERSION,
  type AccountLocalReplica,
  useAccountLocalReplica,
} from './account-local-replica';

type SubchatQueryArgs = { chatId: string; sessionId: string };

export function useQuery<Path extends DataOperationPath>(
  path: Path,
  args: DataOperationArgs<Path> | 'skip',
): DataOperationResult<Path> | undefined {
  const query = useTanStackQuery({
    queryKey: ['ghostbuild-data', path, args],
    queryFn: args === 'skip' ? skipToken : () => executeDataOperation(path, args),
  });

  if (args === 'skip') {
    return undefined;
  }
  if (query.error) {
    throw query.error;
  }
  return query.data;
}

export function useMutation<Path extends DataOperationPath>(path: Path) {
  const { mutateAsync } = useTanStackMutation<DataOperationResult<Path>, Error, DataOperationArgs<Path>>({
    mutationKey: ['ghostbuild-data', path],
    mutationFn: (args) => executeDataOperation(path, args),
  });
  return mutateAsync;
}

const subchatSummarySchema = z.object({
  subchatIndex: z.number().int().nonnegative(),
  description: z.string().optional(),
  updatedAt: z.number().int(),
  transcript: transcriptIdentitySchema,
}) satisfies z.ZodType<SubchatSummary>;

export function subchatQueryKey(args: SubchatQueryArgs | 'skip') {
  return ['ghostbuild-data', api.subchats.get, args] as const;
}

function createSubchatCollection(args: SubchatQueryArgs, replica: AccountLocalReplica | null) {
  const queryOptions = queryCollectionOptions({
    id: `subchats:${args.chatId}`,
    schema: subchatSummarySchema,
    queryKey: subchatQueryKey(args),
    queryFn: ({ signal }) => loadAllSubchats(args.chatId, args.sessionId, signal),
    queryClient,
    getKey: (item) => item.subchatIndex,
    persistedGcTime: Number.POSITIVE_INFINITY,
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
    schema: subchatSummarySchema,
  });
}

type SubchatCollection = ReturnType<typeof createSubchatCollection>;

const subchatCollections = new Map<string, SubchatCollection>();

function getSubchatCollection(args: SubchatQueryArgs, replica: AccountLocalReplica | null) {
  const key = `${args.sessionId}:${args.chatId}:${replica ? 'persisted' : 'memory'}`;
  const existing = subchatCollections.get(key);
  if (existing) {
    return existing;
  }
  const collection = createSubchatCollection(args, replica);
  subchatCollections.set(key, collection);
  return collection;
}

export function useAllSubchats(args: SubchatQueryArgs | 'skip'): SubchatSummary[] | undefined {
  const sessionId = args === 'skip' ? undefined : args.sessionId;
  const replica = useAccountLocalReplica(sessionId);
  const collection = args !== 'skip' && replica !== undefined ? getSubchatCollection(args, replica) : undefined;
  const { data } = useLiveQuery(() => collection, [collection]);
  if (args === 'skip' || !collection) {
    return undefined;
  }
  if (collection.utils.lastError) {
    throw collection.utils.lastError;
  }
  return data ?? [];
}
