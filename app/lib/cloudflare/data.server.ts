import { z } from 'zod';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import type { DataOperationPath } from './data-api';
import { dataOperationArgSchemas } from './data-operation-schemas';
import { getSessionId, requireMatchingSession, UnauthorizedError } from './data/auth.server';
import {
  enforceChatStorageRetention,
  findChat,
  getLatestStorageStateForGeneration,
  updateStorageState,
} from './data/chat-repository.server';
import {
  createSubchat,
  discardEmptyChat,
  earliestRewindableMessageRank,
  getAllChats,
  getChat,
  getSnapshotUrl,
  getSubchats,
  initializeChat,
  removeChat,
  rewindChat,
  setDescription,
  setSubchatDescription,
} from './data/chat-service.server';
import { ensureDataBindings, internalErrorResponse, parseRequestQuery } from './data/http.server';
import { allocateCustomerObjectKey, objectResponse, putObjectAtKey } from './data/object-storage.server';
import { drainDeferredDataGcBestEffort } from './data/deferred-gc.server';
import {
  cancelObjectGcCandidate,
  queueObjectGcCandidate,
  sweepObjectGcCandidatesBestEffort,
} from './data/object-gc.server';
import {
  cloneShare,
  createShare,
  getCurrentSocialShare,
  getShareDescription,
  getSocialShare,
  saveThumbnail,
  upsertSocialShare,
} from './data/share-service.server';
import {
  transcriptCheckpointsEqual,
  transcriptIdentitiesEqual,
  type TranscriptCheckpoint,
  type TranscriptIdentity,
} from 'ghostbuild-agent/transcript';
import { requireChatTranscript, transcriptIdentity } from './data/transcript-repository.server';
import type { BuilderAgent } from '~/agents/builder-agent';
import type { ChatTranscriptRow } from './data/types';
import { getAuthSession } from '~/lib/.server/auth';
import { MAX_THUMBNAIL_BYTES } from '~/lib/thumbnail-policy';
import { readBodyBytesWithLimit, readJsonBodyWithLimit } from '~/lib/bounded-body';
import { readMultipartBodyWithLimits } from '~/lib/bounded-multipart';
import { assertLz4Payload, MESSAGE_HISTORY_LZ4_LIMITS, type Lz4PayloadLimits } from '~/lib/compression-limits';
import { MAX_SUBCHAT_INDEX } from './data-pagination';
import {
  admitChatBackupRequest,
  CHAT_BACKUP_MAX_INTAKE_BYTES,
  completeChatBackupAdmission,
  enforceChatBackupEdgeRateLimit,
  registerChatBackupObject,
  releaseChatBackupAdmissionBestEffort,
  reserveChatBackupBytes,
} from './data/chat-backup-quota.server';
import { deriveProvisionalTitle } from '@summonghost/title-generation';
import { admitThumbnailUpload, releaseThumbnailAdmissionBestEffort } from './data/thumbnail-quota.server';

const dataOperationPathSchema = z.enum(
  Object.keys(dataOperationArgSchemas) as [DataOperationPath, ...DataOperationPath[]],
);
const dataRequestSchema = z.object({
  path: dataOperationPathSchema,
  args: z.unknown(),
});
const publicDataOperationPaths = new Set<DataOperationPath>([
  'share.getShareDescription',
  'socialShare.getSocialShare',
]);
const chatRequestSchema = z.object({
  sessionId: z.string().min(1).max(512),
  chatId: z.string().min(1).max(512),
});
const storeChatRequestSchema = chatRequestSchema.extend({
  lastMessageRank: z.coerce.number().int().nonnegative(),
  lastSubchatIndex: z.coerce.number().int().nonnegative().max(MAX_SUBCHAT_INDEX).default(0),
  partIndex: z.coerce.number().int().nonnegative(),
  transcriptAgentName: z.string().min(1).max(512),
  transcriptGeneration: z.coerce.number().int().nonnegative(),
  transcriptRevision: z.coerce.number().int().nonnegative(),
  transcriptDigest: z.string().regex(/^[a-f0-9]{64}$/),
  transcriptMessageCount: z.coerce.number().int().nonnegative(),
});
const initialMessagesRequestSchema = chatRequestSchema.extend({
  subchatIndex: z.number().int().nonnegative().max(MAX_SUBCHAT_INDEX).optional(),
});
const logger = createScopedLogger('CloudflareDataStorage');
const MAX_DATA_REQUEST_BYTES = 64 * 1024;
const MAX_INITIAL_MESSAGES_REQUEST_BYTES = 8 * 1024;
const MAX_FIRST_MESSAGE_BYTES = 64 * 1024;
const MAX_BACKUP_REQUEST_BYTES = CHAT_BACKUP_MAX_INTAKE_BYTES;
const CHAT_BACKUP_FIELDS = {
  messages: { kind: 'file', maximumBytes: MESSAGE_HISTORY_LZ4_LIMITS.compressedBytes },
  firstMessage: { kind: 'text', maximumBytes: MAX_FIRST_MESSAGE_BYTES },
} as const;

export async function dataAction({
  request,
  env,
  executionCtx,
}: {
  request: Request;
  env: Env;
  executionCtx?: Pick<ExecutionContext, 'waitUntil'>;
}): Promise<Response> {
  try {
    const body = dataRequestSchema.parse(await readJsonBodyWithLimit(request, MAX_DATA_REQUEST_BYTES, 'Data request'));
    ensureDataBindings(env);
    const isPublicOperation = publicDataOperationPaths.has(body.path);
    if (!isPublicOperation) {
      await requireMatchingSession(env, request, getSessionId(body.args));
    }
    const result = await runKnownDataOperation(env, body.path, body.args, request);
    if (!isPublicOperation && executionCtx) {
      executionCtx.waitUntil(drainDeferredDataGcBestEffort(env));
    }
    return Response.json({ result });
  } catch (error) {
    return internalErrorResponse(error, 'Unknown data error');
  }
}

export async function storeChatAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  try {
    ensureDataBindings(env);
    const {
      sessionId,
      chatId,
      lastMessageRank,
      lastSubchatIndex: subchatIndex,
      partIndex,
      transcriptAgentName,
      transcriptGeneration,
      transcriptRevision,
      transcriptDigest,
      transcriptMessageCount,
    } = parseRequestQuery(request, storeChatRequestSchema);
    await requireMatchingSession(env, request, sessionId);
    await enforceChatBackupEdgeRateLimit(env, sessionId);
    let admission = await admitChatBackupRequest(env, {
      ownerId: sessionId,
      chatId,
    });
    try {
      const checkpoint: TranscriptCheckpoint = {
        agentName: transcriptAgentName,
        generation: transcriptGeneration,
        revision: transcriptRevision,
        digest: transcriptDigest,
        messageCount: transcriptMessageCount,
        subchatIndex,
      };
      const chat = await findChat(env.DB, { id: chatId, sessionId });
      if (!chat) {
        return Response.json({ error: 'Chat not found' }, { status: 404 });
      }
      const transcript = await requireChatTranscript(env.DB, { chatId: chat.id, subchatIndex });
      const durableBeforeUpload = await getBuilderTranscriptSnapshot(env, transcriptIdentity(transcript), sessionId);
      if (!transcriptCheckpointsEqual(checkpoint, durableBeforeUpload.checkpoint)) {
        return transcriptConflictResponse(durableBeforeUpload.checkpoint);
      }
      const parts = await readMultipartBodyWithLimits(request, {
        label: 'Chat backup',
        maximumBytes: MAX_BACKUP_REQUEST_BYTES,
        fields: CHAT_BACKUP_FIELDS,
      });
      const messageBlob = parts.get('messages');
      const firstMessage = parts.get('firstMessage');
      if (messageBlob instanceof Blob) {
        await validateLz4Upload(messageBlob, MESSAGE_HISTORY_LZ4_LIMITS);
      }
      admission = await reserveChatBackupBytes(
        env,
        admission,
        messageBlob instanceof Blob ? messageBlob.size : 0,
        messageBlob instanceof Blob ? 1 : 0,
      );
      await enforceChatStorageRetention(env.DB, { chatId: chat.id, reserveStates: 1 });
      const initialDescription = typeof firstMessage === 'string' ? deriveProvisionalTitle(firstMessage) : null;
      const storageKey = messageBlob instanceof Blob ? allocateCustomerObjectKey(sessionId, 'message-history') : null;
      const storageGcReceipt = storageKey ? await queueObjectGcCandidate(env.DB, storageKey) : null;
      if (storageKey && messageBlob instanceof Blob) {
        await registerChatBackupObject(env.DB, {
          admission,
          storageKey,
          sizeBytes: messageBlob.size,
          kind: 'message-history',
        });
        await putObjectAtKey(env, storageKey, messageBlob);
      }

      const durableAfterUpload = await getBuilderTranscriptSnapshot(env, transcriptIdentity(transcript), sessionId);
      if (!transcriptCheckpointsEqual(checkpoint, durableAfterUpload.checkpoint)) {
        return transcriptConflictResponse(durableAfterUpload.checkpoint);
      }

      const update = await updateStorageState(env.DB, {
        sessionId,
        chatId,
        storageKey,
        snapshotKey: null,
        lastMessageRank,
        subchatIndex,
        partIndex,
        initialDescription,
        checkpoint,
      });
      if (!update.accepted) {
        return transcriptConflictResponse();
      }
      await completeChatBackupAdmission(env.DB, admission);
      if (update.retainedStorageKey && storageGcReceipt) {
        await cancelObjectGcCandidateBestEffort(env.DB, storageGcReceipt);
      }
      try {
        await enforceChatStorageRetention(env.DB, { chatId: chat.id, reserveStates: 0 });
      } catch (error) {
        logger.warn('Unable to compact retained chat checkpoints after save', { chatId: chat.id, error });
      }
      await sweepObjectGcCandidatesBestEffort(env);
      return new Response(null, { status: 200 });
    } finally {
      await releaseChatBackupAdmissionBestEffort(env.DB, admission);
    }
  } catch (error) {
    return internalErrorResponse(error, 'Unknown chat storage error');
  }
}

function transcriptConflictResponse(checkpoint?: TranscriptCheckpoint | null): Response {
  return Response.json(
    {
      error: 'The agent transcript advanced before this backup was saved. Retry with the latest transcript.',
      ...(checkpoint === undefined ? {} : { checkpoint }),
    },
    { status: 409 },
  );
}

function getBuilderTranscriptSnapshot(
  env: Env,
  identity: TranscriptIdentity,
  ownerId: string,
): ReturnType<BuilderAgent['getTranscriptSnapshot']> {
  const stub = env.BuilderAgent.getByName(identity.agentName) as unknown as Pick<
    BuilderAgent,
    'getTranscriptSnapshotForOwner'
  >;
  return stub.getTranscriptSnapshotForOwner(identity, ownerId);
}

async function getBuilderTranscriptSnapshotIfReady(
  env: Env,
  identity: TranscriptIdentity,
  ownerId: string,
): Promise<Awaited<ReturnType<BuilderAgent['getTranscriptSnapshot']>> | null> {
  try {
    return await getBuilderTranscriptSnapshot(env, identity, ownerId);
  } catch (error) {
    logger.warn('Durable transcript is unavailable; using generation-scoped materialized chat history', {
      agentName: identity.agentName,
      ...(error instanceof Response ? { status: error.status } : {}),
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function cancelObjectGcCandidateBestEffort(
  db: D1Database,
  receipt: Awaited<ReturnType<typeof queueObjectGcCandidate>>,
): Promise<void> {
  try {
    await cancelObjectGcCandidate(db, receipt);
  } catch (error) {
    logger.warn('Unable to cancel live chat object cleanup receipt', { key: receipt.storageKey, error });
  }
}

export async function initialMessagesAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  try {
    ensureDataBindings(env);
    const session = await getAuthSession(env, request);
    if (!session) {
      throw new UnauthorizedError();
    }
    const body = initialMessagesRequestSchema.parse(
      await readJsonBodyWithLimit(request, MAX_INITIAL_MESSAGES_REQUEST_BYTES, 'Initial messages request'),
    );
    if (body.sessionId !== session.user.id) {
      throw new UnauthorizedError();
    }
    const chat = await findChat(env.DB, { id: body.chatId, sessionId: body.sessionId });
    if (!chat) {
      return new Response(`Chat not found: ${body.chatId}`, { status: 404 });
    }
    const transcript = await requireChatTranscript(env.DB, {
      chatId: chat.id,
      subchatIndex: body.subchatIndex ?? 0,
    });
    const state = await getLatestStorageStateForGeneration(env.DB, {
      chatId: chat.id,
      subchatIndex: transcript.subchat_index,
      generation: transcript.generation,
      lastMessageRank: chat.last_message_rank ?? undefined,
    });
    const durable = await getBuilderTranscriptSnapshotIfReady(env, transcriptIdentity(transcript), session.user.id);
    if (
      durable?.checkpoint &&
      transcriptIdentitiesEqual(durable.checkpoint, transcriptIdentity(transcript)) &&
      durable.checkpoint.revision > 0
    ) {
      return Response.json(
        {
          version: 2,
          transcript: durable.checkpoint,
          messages: durable.messages,
        },
        { headers: transcriptResponseHeaders(transcript, 'durable') },
      );
    }
    if (!state?.storage_key) {
      return new Response(null, { status: 204, headers: transcriptResponseHeaders(transcript, 'empty') });
    }
    const materialized = await objectResponse(env, state.storage_key);
    const headers = transcriptResponseHeaders(transcript, 'materialized', materialized.headers);
    return new Response(materialized.body, {
      status: materialized.status,
      statusText: materialized.statusText,
      headers,
    });
  } catch (error) {
    return internalErrorResponse(error, 'Unknown initial messages error');
  }
}

function transcriptResponseHeaders(
  transcript: ChatTranscriptRow,
  source: 'durable' | 'materialized' | 'empty',
  initial?: HeadersInit,
): Headers {
  const headers = new Headers(initial);
  headers.set('X-Ghostbuild-Transcript-Source', source);
  headers.set('X-Ghostbuild-Transcript-Agent', transcript.agent_name);
  headers.set('X-Ghostbuild-Transcript-Generation', transcript.generation.toString());
  headers.set('X-Ghostbuild-Transcript-Subchat', transcript.subchat_index.toString());
  return headers;
}

export async function uploadThumbnailAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  try {
    ensureDataBindings(env);
    const { sessionId, chatId } = parseRequestQuery(request, chatRequestSchema);
    await requireMatchingSession(env, request, sessionId);
    const chat = await findChat(env.DB, { id: chatId, sessionId });
    if (!chat) {
      return Response.json({ error: 'Chat not found' }, { status: 404 });
    }
    const admission = await admitThumbnailUpload(env, { ownerId: sessionId, chatId: chat.id });
    try {
      const imageBytes = await readBodyBytesWithLimit(request, MAX_THUMBNAIL_BYTES, 'Thumbnail image');
      const image = new Blob([imageBytes], { type: request.headers.get('content-type') ?? '' });
      const validationError = validateThumbnail(image);
      if (validationError) {
        return validationError;
      }
      const storageId = await saveThumbnail(env, { admission, image });
      return Response.json({ storageId });
    } finally {
      await releaseThumbnailAdmissionBestEffort(env.DB, admission);
    }
  } catch (error) {
    return internalErrorResponse(error, 'Unknown thumbnail upload error');
  }
}

export async function storageObjectAction({
  request,
  key,
  env,
}: {
  request: Request;
  key: string;
  env: Env;
}): Promise<Response> {
  let storageKey: string;
  try {
    storageKey = decodeURIComponent(key);
  } catch {
    return new Response('Not found', { status: 404 });
  }

  const publicThumbnail = await env.DB.prepare(
    `SELECT 1 AS found
     FROM social_shares
     JOIN chats ON chats.id = social_shares.chat_id
     WHERE social_shares.thumbnail_image_key = ?
       AND social_shares.is_shared = 1
       AND chats.is_deleted = 0
     LIMIT 1`,
  )
    .bind(storageKey)
    .first<{ found: number }>();
  if (publicThumbnail) {
    return withStorageCachePolicy(await objectResponse(env, storageKey), 'no-store');
  }

  const session = await getAuthSession(env, request);
  if (!session || !(await userOwnsStorageKey(env.DB, session.user.id, storageKey))) {
    return new Response('Not found', { status: 404 });
  }
  return withStorageCachePolicy(await objectResponse(env, storageKey), 'private, no-store');
}

async function userOwnsStorageKey(db: D1Database, userId: string, storageKey: string): Promise<boolean> {
  const reference = await db
    .prepare(
      `SELECT 1 AS found
       FROM chats
       WHERE creator_id = ? AND is_deleted = 0 AND snapshot_key = ?
       UNION ALL
       SELECT 1 AS found
       FROM chat_message_states
       JOIN chats ON chats.id = chat_message_states.chat_id
       WHERE chats.creator_id = ? AND chats.is_deleted = 0
         AND (chat_message_states.storage_key = ? OR chat_message_states.snapshot_key = ?)
       UNION ALL
       SELECT 1 AS found
       FROM social_shares
       JOIN chats ON chats.id = social_shares.chat_id
       WHERE chats.creator_id = ? AND chats.is_deleted = 0
         AND social_shares.thumbnail_image_key = ?
       LIMIT 1`,
    )
    .bind(userId, storageKey, userId, storageKey, storageKey, userId, storageKey)
    .first<{ found: number }>();
  return reference !== null;
}

function withStorageCachePolicy(response: Response, cacheControl: string): Response {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', cacheControl);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function runKnownDataOperation(env: Env, path: DataOperationPath, rawArgs: unknown, _request: Request): unknown {
  switch (path) {
    case 'messages.initializeChat':
      return initializeChat(env.DB, dataOperationArgSchemas[path].parse(rawArgs));
    case 'messages.discardEmptyChat':
      return discardEmptyChat(env.DB, dataOperationArgSchemas[path].parse(rawArgs));
    case 'messages.get':
      return getChat(env.DB, dataOperationArgSchemas[path].parse(rawArgs));
    case 'messages.getAll':
      return getAllChats(env.DB, dataOperationArgSchemas[path].parse(rawArgs));
    case 'messages.setDescription':
      return setDescription(env.DB, dataOperationArgSchemas[path].parse(rawArgs));
    case 'messages.remove':
      return removeChat(env.DB, dataOperationArgSchemas[path].parse(rawArgs));
    case 'messages.earliestRewindableMessageRank':
      return earliestRewindableMessageRank(env.DB, dataOperationArgSchemas[path].parse(rawArgs));
    case 'messages.rewindChat':
      return rewindChat(env.DB, dataOperationArgSchemas[path].parse(rawArgs));
    case 'subchats.get':
      return getSubchats(env.DB, dataOperationArgSchemas[path].parse(rawArgs));
    case 'subchats.create':
      return createSubchat(env.DB, dataOperationArgSchemas[path].parse(rawArgs));
    case 'subchats.setDescription':
      return setSubchatDescription(env.DB, dataOperationArgSchemas[path].parse(rawArgs));
    case 'snapshot.getSnapshotUrl':
      return getSnapshotUrl(env, dataOperationArgSchemas[path].parse(rawArgs));
    case 'share.create':
      return createShare(env.DB, dataOperationArgSchemas[path].parse(rawArgs));
    case 'share.getShareDescription':
      return getShareDescription(env.DB, dataOperationArgSchemas[path].parse(rawArgs));
    case 'share.clone':
      return cloneShare(env, dataOperationArgSchemas[path].parse(rawArgs));
    case 'socialShare.share':
      return upsertSocialShare(env.DB, dataOperationArgSchemas[path].parse(rawArgs));
    case 'socialShare.getCurrentSocialShare':
      return getCurrentSocialShare(env.DB, dataOperationArgSchemas[path].parse(rawArgs));
    case 'socialShare.getSocialShare':
      return getSocialShare(env, dataOperationArgSchemas[path].parse(rawArgs).code);
    default:
      path satisfies never;
      throw new Error(`Unsupported data operation: ${path}`);
  }
}

function validateThumbnail(image: Blob): Response | null {
  if (!['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp'].includes(image.type)) {
    return Response.json({ error: 'Invalid file type. Use AVIF, GIF, JPEG, PNG, or WebP.' }, { status: 400 });
  }
  if (image.size > MAX_THUMBNAIL_BYTES) {
    return Response.json({ error: 'Thumbnail image exceeds maximum size of 5MB' }, { status: 413 });
  }
  if (image.size === 0) {
    return Response.json({ error: 'Thumbnail image is empty' }, { status: 400 });
  }
  return null;
}

async function validateLz4Upload(blob: Blob, limits: Lz4PayloadLimits): Promise<void> {
  assertLz4Payload(new Uint8Array(await blob.arrayBuffer()), limits);
}
