import { createCollection, eq, type LoadSubsetOptions } from '@tanstack/db';
import { parseLoadSubsetOptions, queryCollectionOptions } from '@tanstack/query-db-collection';
import { useLiveQuery } from '@tanstack/react-db';
import { useCallback } from 'react';
import { z } from 'zod';
import {
  TRANSCRIPT_HISTORY_FORMAT_VERSION,
  transcriptCheckpointSchema,
  transcriptIdentitiesEqual,
  transcriptIdentitySchema,
  type TranscriptCheckpoint,
  type TranscriptIdentity,
} from 'ghostbuild-agent/transcript';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { executeDataOperation, UserRuntimeRequestError } from './client';
import { api } from './data-api';
import { queryClient } from '~/lib/stores/reactQueryClient';
import type { SerializedMessage } from '~/lib/stores/startup/messages';
import { serializeCompleteMessages } from '~/lib/stores/startup/messages';
import {
  ACCOUNT_LOCAL_REPLICA_SCHEMA_VERSION,
  ACCOUNT_LOCAL_REPLICA_GC_TIME,
  registerAccountCollectionDisposer,
  type AccountLocalReplica,
  useAccountLocalReplica,
} from './account-local-replica';
import { fetchUserRuntime } from './runtime-session';
import { useQueryCacheError } from './use-query-cache-error';

const TRANSCRIPT_QUERY_KEY_PREFIX = ['ghostbuild-local', 'transcripts'] as const;
const TRANSCRIPT_FETCH_TIMEOUT_MS = 30_000;

const serializedMessageShape = z
  .object({
    id: z.string().min(1),
    role: z.enum(['system', 'user', 'assistant']),
    createdAt: z.number().optional(),
    parts: z.array(z.object({ type: z.string().min(1) }).loose()).optional(),
  })
  .loose();

const serializedMessageSchema = z.custom<SerializedMessage>(
  (value) => serializedMessageShape.safeParse(value).success,
  'Invalid serialized message.',
);

const transcriptHistorySchema = z
  .object({
    version: z.literal(TRANSCRIPT_HISTORY_FORMAT_VERSION),
    transcript: transcriptCheckpointSchema,
    messages: z.array(serializedMessageSchema),
  })
  .strict();

const missingChatTranscriptSchema = z.object({
  requestKey: z.string().min(1),
  status: z.literal('missing'),
});

const readyChatTranscriptSchema = z.object({
  requestKey: z.string().min(1),
  status: z.literal('ready'),
  loadedChatId: z.string().min(1),
  initialId: z.string().min(1),
  description: z.string().optional(),
  loadedSubchatIndex: z.number().int().nonnegative(),
  transcript: transcriptIdentitySchema,
  checkpoint: transcriptCheckpointSchema.nullable(),
  messages: z.array(serializedMessageSchema),
});

const cachedChatTranscriptSchema = z.discriminatedUnion('status', [
  missingChatTranscriptSchema,
  readyChatTranscriptSchema,
]);

type CachedChatTranscript = z.infer<typeof cachedChatTranscriptSchema>;
type ReadyChatTranscript = z.infer<typeof readyChatTranscriptSchema>;

type TranscriptRequest = {
  chatId: string;
  subchatIndex?: number;
};

function transcriptRequestKey(request: TranscriptRequest): string {
  return JSON.stringify([request.chatId, request.subchatIndex ?? null]);
}

function parseTranscriptRequestKey(value: string): TranscriptRequest {
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== 'string' ||
    parsed[0].length === 0 ||
    (parsed[1] !== null && (!Number.isSafeInteger(parsed[1]) || parsed[1] < 0))
  ) {
    throw new Error('Invalid persisted transcript request key.');
  }
  return {
    chatId: parsed[0],
    ...(parsed[1] === null ? {} : { subchatIndex: parsed[1] as number }),
  };
}

function requestKeyFromSubsetOptions(options: unknown): string | undefined {
  const parsed = parseLoadSubsetOptions(options as LoadSubsetOptions | null | undefined);
  const requestFilter = parsed.filters.find(
    (filter) =>
      filter.operator === 'eq' &&
      filter.field.length === 1 &&
      filter.field[0] === 'requestKey' &&
      typeof filter.value === 'string',
  );
  return typeof requestFilter?.value === 'string' ? requestFilter.value : undefined;
}

function createTranscriptCollection(sessionId: string, replica: AccountLocalReplica | null) {
  const queryOptions = queryCollectionOptions({
    id: 'transcripts',
    schema: cachedChatTranscriptSchema,
    syncMode: 'on-demand',
    queryKey: (options) => {
      const requestKey = requestKeyFromSubsetOptions(options);
      return requestKey
        ? [...TRANSCRIPT_QUERY_KEY_PREFIX, sessionId, requestKey]
        : [...TRANSCRIPT_QUERY_KEY_PREFIX, sessionId];
    },
    queryFn: async ({ meta, signal }) => {
      const requestKey = requestKeyFromSubsetOptions(meta?.loadSubsetOptions);
      if (!requestKey) {
        throw new Error('Transcript queries require an exact request key.');
      }
      return [await loadChatTranscript(sessionId, requestKey, parseTranscriptRequestKey(requestKey), signal)];
    },
    queryClient,
    getKey: (item) => item.requestKey,
    persistedGcTime: ACCOUNT_LOCAL_REPLICA_GC_TIME,
    refetchOnMount: 'always',
    refetchOnReconnect: true,
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
    schema: cachedChatTranscriptSchema,
  });
}

type TranscriptCollection = ReturnType<typeof createTranscriptCollection>;

const transcriptCollections = new Map<string, TranscriptCollection>();
const activeTranscriptCollections = new Map<string, TranscriptCollection>();

registerAccountCollectionDisposer(async () => {
  const collections = new Set(transcriptCollections.values());
  transcriptCollections.clear();
  activeTranscriptCollections.clear();
  await Promise.allSettled([...collections].map((collection) => collection.cleanup()));
});

function getTranscriptCollection(sessionId: string, replica: AccountLocalReplica | null) {
  const cacheKey = `${sessionId}:${replica ? 'persisted' : 'memory'}`;
  const existing = transcriptCollections.get(cacheKey);
  if (existing) {
    activeTranscriptCollections.set(sessionId, existing);
    return existing;
  }
  const collection = createTranscriptCollection(sessionId, replica);
  transcriptCollections.set(cacheKey, collection);
  activeTranscriptCollections.set(sessionId, collection);
  return collection;
}

export function useCachedChatTranscript(
  sessionId: string | null | undefined,
  request: TranscriptRequest | undefined,
): {
  transcript: CachedChatTranscript | undefined;
  isLoading: boolean;
  error: unknown;
  retry: () => void;
} {
  const replica = useAccountLocalReplica(sessionId);
  const collection = sessionId && replica !== undefined ? getTranscriptCollection(sessionId, replica) : undefined;
  const requestKey = request ? transcriptRequestKey(request) : undefined;
  const query = useLiveQuery(
    (q) =>
      collection && requestKey
        ? q.from({ transcript: collection }).where(({ transcript }) => eq(transcript.requestKey, requestKey))
        : undefined,
    [collection, requestKey],
  );
  const error = useQueryCacheError(
    sessionId && requestKey ? [...TRANSCRIPT_QUERY_KEY_PREFIX, sessionId, requestKey] : undefined,
  );
  const retry = useCallback(() => {
    void collection?.utils.clearError().catch(() => undefined);
  }, [collection]);
  return {
    transcript: query.data?.[0],
    isLoading: replica === undefined || query.isLoading,
    error,
    retry,
  };
}

export function cachePersistedTranscript(args: {
  sessionId: string;
  chatId: string;
  subchatIndex: number;
  messages: GhostbuildMessage[];
  lastMessageRank: number;
  partIndex: number;
  checkpoint: TranscriptCheckpoint;
}): void {
  const collection = activeTranscriptCollections.get(args.sessionId);
  if (!collection) {
    return;
  }
  const exactRequestKey = transcriptRequestKey({
    chatId: args.chatId,
    subchatIndex: args.subchatIndex,
  });
  const latestRequestKey = transcriptRequestKey({ chatId: args.chatId });
  const existing = collection.get(exactRequestKey) ?? collection.get(latestRequestKey);
  if (!existing || existing.status !== 'ready') {
    return;
  }
  const updated: ReadyChatTranscript = {
    requestKey: exactRequestKey,
    status: 'ready',
    loadedChatId: existing.loadedChatId,
    initialId: existing.initialId,
    ...(existing.description === undefined ? {} : { description: existing.description }),
    loadedSubchatIndex: args.subchatIndex,
    transcript: transcriptIdentity(args.checkpoint),
    checkpoint: args.checkpoint,
    messages: serializeCompleteMessages(args.messages, args.lastMessageRank, args.partIndex),
  };
  collection.utils.writeBatch(() => {
    collection.utils.writeUpsert({ ...updated, requestKey: exactRequestKey });
    collection.utils.writeUpsert({ ...updated, requestKey: latestRequestKey });
  });
}

async function loadChatTranscript(
  sessionId: string,
  requestKey: string,
  request: TranscriptRequest,
  signal: AbortSignal,
): Promise<CachedChatTranscript> {
  signal.throwIfAborted();
  const chatInfo = await executeDataOperation(
    api.messages.get,
    {
      id: request.chatId,
      sessionId,
      ...(request.subchatIndex === undefined ? {} : { subchatIndex: request.subchatIndex }),
    },
    { signal },
  );
  signal.throwIfAborted();
  if (chatInfo === null) {
    return { requestKey, status: 'missing' };
  }
  const loadedSubchatIndex = request.subchatIndex ?? chatInfo.subchatIndex;
  const response = await fetchUserRuntime('/v1/chats/messages', {
    method: 'POST',
    body: JSON.stringify({
      chatId: request.chatId,
      sessionId,
      subchatIndex: loadedSubchatIndex,
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(TRANSCRIPT_FETCH_TIMEOUT_MS)]),
  });
  if (!response.ok) {
    throw await projectMessagesRequestError(response);
  }
  const responseTranscript = transcriptIdentityFromHeaders(response.headers);
  const history =
    response.status === 204 ? { messages: [], checkpoint: null } : parseMessageHistory(await response.json());
  signal.throwIfAborted();
  return {
    requestKey,
    status: 'ready',
    loadedChatId: chatInfo.initialId,
    initialId: chatInfo.initialId,
    description: chatInfo.description,
    loadedSubchatIndex,
    transcript: responseTranscript,
    checkpoint:
      history.checkpoint && transcriptIdentitiesEqual(history.checkpoint, responseTranscript)
        ? history.checkpoint
        : null,
    messages: history.messages,
  };
}

export async function projectMessagesRequestError(response: Response): Promise<UserRuntimeRequestError> {
  const payload = (await response.json().catch(() => null)) as { error?: unknown; retryable?: unknown } | null;
  const detail = typeof payload?.error === 'string' ? `: ${payload.error}` : '';
  return new UserRuntimeRequestError(
    `Failed to fetch project messages (${response.status})${detail}`,
    response.status,
    payload?.retryable,
  );
}

function transcriptIdentity(checkpoint: TranscriptCheckpoint): TranscriptIdentity {
  return {
    agentName: checkpoint.agentName,
    generation: checkpoint.generation,
    subchatIndex: checkpoint.subchatIndex,
  };
}

export function transcriptIdentityFromHeaders(headers: Headers): TranscriptIdentity {
  const generation = headers.get('X-Ghostbuild-Transcript-Generation');
  const subchatIndex = headers.get('X-Ghostbuild-Transcript-Subchat');
  const result = transcriptIdentitySchema.safeParse({
    agentName: headers.get('X-Ghostbuild-Transcript-Agent'),
    generation: parseTranscriptHeaderInteger(generation),
    subchatIndex: parseTranscriptHeaderInteger(subchatIndex),
  });
  if (!result.success) {
    throw new Error('The user runtime returned invalid transcript identity headers.');
  }
  return result.data;
}

function parseTranscriptHeaderInteger(value: string | null): number {
  if (value === null || !/^(?:0|[1-9]\d*)$/.test(value)) {
    return Number.NaN;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
}

export function parseMessageHistory(deserialized: unknown): {
  messages: SerializedMessage[];
  checkpoint: TranscriptCheckpoint | null;
} {
  const history = transcriptHistorySchema.parse(deserialized);
  return {
    messages: history.messages,
    checkpoint: history.transcript,
  };
}
