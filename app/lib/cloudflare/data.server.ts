import { z } from 'zod';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import type { DataOperationPath } from './data-api';
import { dataOperationArgSchemas } from './data-operation-schemas';
import { claimGuestSession, getSessionId, requireMatchingSession } from './data/auth.server';
import { findChat, getLatestStorageStateForGeneration, updateStorageState } from './data/chat-repository.server';
import {
  createSubchat,
  earliestRewindableMessageRank,
  getAllChats,
  getChat,
  getSnapshotUrl,
  getSubchats,
  initializeChat,
  removeChat,
  rewindChat,
  setDescription,
  setUrlId,
} from './data/chat-service.server';
import { ensureDataBindings, internalErrorResponse, parseRequestQuery } from './data/http.server';
import { deleteObject, objectResponse, putObject } from './data/object-storage.server';
import { sweepObjectGcCandidatesBestEffort } from './data/object-gc.server';
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

const dataOperationPathSchema = z.enum(
  Object.keys(dataOperationArgSchemas) as [DataOperationPath, ...DataOperationPath[]],
);
const dataRequestSchema = z.object({
  path: dataOperationPathSchema,
  args: z.unknown(),
});
const chatRequestSchema = z.object({
  sessionId: z.string().min(1),
  chatId: z.string().min(1),
});
const storeChatRequestSchema = chatRequestSchema.extend({
  lastMessageRank: z.coerce.number().int().nonnegative(),
  lastSubchatIndex: z.coerce.number().int().nonnegative().default(0),
  partIndex: z.coerce.number().int().nonnegative(),
  transcriptAgentName: z.string().min(1).max(512),
  transcriptGeneration: z.coerce.number().int().nonnegative(),
  transcriptRevision: z.coerce.number().int().nonnegative(),
  transcriptDigest: z.string().regex(/^[a-f0-9]{64}$/),
  transcriptMessageCount: z.coerce.number().int().nonnegative(),
});
const initialMessagesRequestSchema = chatRequestSchema.extend({
  subchatIndex: z.number().int().nonnegative().optional(),
});
const logger = createScopedLogger('CloudflareDataStorage');

export async function dataAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  try {
    const body = dataRequestSchema.parse(await request.json());
    ensureDataBindings(env);
    await requireMatchingSession(env, request, getSessionId(body.args));
    const result = await runKnownDataOperation(env, body.path, body.args, request);
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
    const durableBeforeUpload = await getBuilderTranscriptSnapshot(env, transcriptIdentity(transcript));
    if (!transcriptCheckpointsEqual(checkpoint, durableBeforeUpload.checkpoint)) {
      return transcriptConflictResponse();
    }
    const formData = await request.formData();
    const messageBlob = formData.get('messages');
    const snapshotBlob = formData.get('snapshot');
    const firstMessage = formData.get('firstMessage');
    const initialDescription = typeof firstMessage === 'string' ? firstMessage.slice(0, 120) : null;
    let storageKey: string | null = null;
    let snapshotKey: string | null = null;
    try {
      storageKey = messageBlob instanceof Blob ? await putObject(env, 'message-history', messageBlob) : null;
      snapshotKey = snapshotBlob instanceof Blob ? await putObject(env, 'snapshots', snapshotBlob) : null;
    } catch (error) {
      await deleteObjectsBestEffort(env, [storageKey, snapshotKey]);
      throw error;
    }

    const durableAfterUpload = await getBuilderTranscriptSnapshot(env, transcriptIdentity(transcript));
    if (!transcriptCheckpointsEqual(checkpoint, durableAfterUpload.checkpoint)) {
      await deleteObjectsBestEffort(env, [storageKey, snapshotKey]);
      return transcriptConflictResponse();
    }

    let update;
    try {
      update = await updateStorageState(env.DB, {
        sessionId,
        chatId,
        storageKey,
        snapshotKey,
        lastMessageRank,
        subchatIndex,
        partIndex,
        initialDescription,
        checkpoint,
      });
    } catch (error) {
      await deleteObjectsBestEffort(env, [storageKey, snapshotKey]);
      throw error;
    }
    if (!update.accepted) {
      await deleteObjectsBestEffort(env, [storageKey, snapshotKey]);
      return transcriptConflictResponse();
    }
    await deleteObjectsBestEffort(env, [
      update.retainedStorageKey ? null : storageKey,
      update.retainedSnapshotKey ? null : snapshotKey,
    ]);
    await sweepObjectGcCandidatesBestEffort(env);
    return new Response(null, { status: 200 });
  } catch (error) {
    return internalErrorResponse(error, 'Unknown chat storage error');
  }
}

function transcriptConflictResponse(): Response {
  return Response.json(
    { error: 'The agent transcript advanced before this backup was saved. Retry with the latest transcript.' },
    { status: 409 },
  );
}

function getBuilderTranscriptSnapshot(
  env: Env,
  identity: TranscriptIdentity,
): ReturnType<BuilderAgent['getTranscriptSnapshot']> {
  const stub = env.BuilderAgent.getByName(identity.agentName) as unknown as Pick<BuilderAgent, 'getTranscriptSnapshot'>;
  return stub.getTranscriptSnapshot(identity);
}

async function deleteObjectsBestEffort(env: Env, keys: Array<string | null>): Promise<void> {
  await Promise.all(uniqueKeys(keys).map((key) => deleteObjectAndLogFailure(env, key)));
}

async function deleteObjectAndLogFailure(env: Env, key: string): Promise<void> {
  try {
    await deleteObject(env, key);
  } catch (error) {
    logger.warn('Unable to clean up uploaded chat object', { key, error });
  }
}

function uniqueKeys(keys: Array<string | null>): string[] {
  return Array.from(new Set(keys.filter((key): key is string => key !== null)));
}

export async function initialMessagesAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  try {
    ensureDataBindings(env);
    const body = initialMessagesRequestSchema.parse(await request.json());
    await requireMatchingSession(env, request, body.sessionId);
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
    const durable = await getBuilderTranscriptSnapshot(env, transcriptIdentity(transcript));
    if (
      durable.checkpoint &&
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
    const image = await request.blob();
    const validationError = validateThumbnail(image);
    if (validationError) {
      return validationError;
    }
    const storageId = await saveThumbnail(env, { sessionId, chatId, image });
    return Response.json({ storageId });
  } catch (error) {
    return internalErrorResponse(error, 'Unknown thumbnail upload error');
  }
}

export function storageObjectAction({ key, env }: { key: string; env: Env }): Promise<Response> {
  return objectResponse(env, decodeURIComponent(key));
}

function runKnownDataOperation(env: Env, path: DataOperationPath, rawArgs: unknown, request: Request): unknown {
  switch (path) {
    case 'messages.claimGuestSession':
      return claimGuestSession(env, dataOperationArgSchemas[path].parse(rawArgs), request);
    case 'messages.initializeChat':
      return initializeChat(env.DB, dataOperationArgSchemas[path].parse(rawArgs));
    case 'messages.get':
      return getChat(env.DB, dataOperationArgSchemas[path].parse(rawArgs));
    case 'messages.getAll':
      return getAllChats(env.DB, dataOperationArgSchemas[path].parse(rawArgs));
    case 'messages.setUrlId':
      return setUrlId(env.DB, dataOperationArgSchemas[path].parse(rawArgs));
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
    case 'snapshot.getSnapshotUrl':
      return getSnapshotUrl(env, dataOperationArgSchemas[path].parse(rawArgs));
    case 'share.create':
      return createShare(env.DB, dataOperationArgSchemas[path].parse(rawArgs));
    case 'share.getShareDescription':
      return getShareDescription(env.DB, dataOperationArgSchemas[path].parse(rawArgs));
    case 'share.clone':
      return cloneShare(env.DB, dataOperationArgSchemas[path].parse(rawArgs));
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
  if (!image.type.startsWith('image/')) {
    return Response.json({ error: 'Invalid file type. Only images are allowed.' }, { status: 400 });
  }
  if (image.size > 5 * 1024 * 1024) {
    return Response.json({ error: 'Thumbnail image exceeds maximum size of 5MB' }, { status: 413 });
  }
  return null;
}
