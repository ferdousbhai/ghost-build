import { deriveProvisionalTitle } from '@summonghost/title-generation';
import {
  TRANSCRIPT_HISTORY_FORMAT_VERSION,
  transcriptCheckpointsEqual,
  transcriptIdentitiesEqual,
  type TranscriptCheckpoint,
  type TranscriptIdentity,
} from 'ghostbuild-agent/transcript';
import { z } from 'zod';
import type { BuilderAgent } from '~/agents/builder-agent';
import { readJsonBodyWithLimit } from '~/lib/bounded-body';
import { readMultipartBodyWithLimits } from '~/lib/bounded-multipart';
import { MAX_SUBCHAT_INDEX } from './data-pagination';
import type { DataOperationPath } from './data-api';
import { dataOperationArgSchemas } from './data-operation-schemas';
import { getSessionId, UnauthorizedError } from './data/auth.server';
import { findChat, updateChatCheckpoint } from './data/chat-repository.server';
import {
  createSubchat,
  discardEmptyChat,
  getAllChats,
  getChat,
  getSubchats,
  initializeChat,
  removeChat,
  setDescription,
  setSubchatDescription,
} from './data/chat-service.server';
import { sweepAgentGcCandidatesBestEffort } from './data/agent-gc.server';
import { ensureDataBindings, internalErrorResponse, parseRequestQuery } from './data/http.server';
import { requireChatTranscript, transcriptIdentity } from './data/transcript-repository.server';
import { retryDurableObjectRpc } from './durable-object-rpc.server';
import type { ChatTranscriptRow } from './data/types';

const dataOperationPathSchema = z.enum(
  Object.keys(dataOperationArgSchemas) as [DataOperationPath, ...DataOperationPath[]],
);
const dataRequestSchema = z.object({ path: dataOperationPathSchema, args: z.unknown() });
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
const MAX_DATA_REQUEST_BYTES = 64 * 1024;
const MAX_INITIAL_MESSAGES_REQUEST_BYTES = 8 * 1024;
const MAX_FIRST_MESSAGE_BYTES = 64 * 1024;

export async function userRuntimeDataAction(args: {
  request: Request;
  env: Env;
  userId: string;
  executionCtx?: Pick<ExecutionContext, 'waitUntil'>;
}): Promise<Response> {
  try {
    const body = dataRequestSchema.parse(
      await readJsonBodyWithLimit(args.request, MAX_DATA_REQUEST_BYTES, 'Data request'),
    );
    ensureDataBindings(args.env);
    if (getSessionId(body.args) !== args.userId) {
      throw new UnauthorizedError();
    }
    const result = runKnownDataOperation(args.env.DB, body.path, body.args);
    args.executionCtx?.waitUntil(sweepAgentGcCandidatesBestEffort(args.env));
    return Response.json({ result: await result });
  } catch (error) {
    return internalErrorResponse(error, 'Unknown data error');
  }
}

export async function userRuntimeStoreChatAction(args: {
  request: Request;
  env: Env;
  userId: string;
}): Promise<Response> {
  try {
    ensureDataBindings(args.env);
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
    } = parseRequestQuery(args.request, storeChatRequestSchema);
    if (sessionId !== args.userId) {
      throw new UnauthorizedError();
    }
    const checkpoint: TranscriptCheckpoint = {
      agentName: transcriptAgentName,
      generation: transcriptGeneration,
      revision: transcriptRevision,
      digest: transcriptDigest,
      messageCount: transcriptMessageCount,
      subchatIndex,
    };
    const chat = await findChat(args.env.DB, { id: chatId, sessionId });
    if (!chat) {
      return Response.json({ error: 'Chat not found' }, { status: 404 });
    }
    const transcript = await requireChatTranscript(args.env.DB, { chatId: chat.id, subchatIndex });
    const durable = await getBuilderTranscriptSnapshot(args.env, transcriptIdentity(transcript), sessionId);
    if (!transcriptCheckpointsEqual(checkpoint, durable.checkpoint)) {
      return transcriptConflictResponse(durable.checkpoint);
    }
    const parts = await readMultipartBodyWithLimits(args.request, {
      label: 'Chat metadata',
      maximumBytes: MAX_FIRST_MESSAGE_BYTES + 16 * 1024,
      fields: { firstMessage: { kind: 'text', maximumBytes: MAX_FIRST_MESSAGE_BYTES } },
    });
    const firstMessage = parts.get('firstMessage');
    const update = await updateChatCheckpoint(args.env.DB, {
      sessionId,
      chatId,
      lastMessageRank,
      subchatIndex,
      partIndex,
      initialDescription: typeof firstMessage === 'string' ? deriveProvisionalTitle(firstMessage) : null,
      checkpoint,
    });
    return update.accepted ? new Response(null, { status: 200 }) : transcriptConflictResponse();
  } catch (error) {
    return internalErrorResponse(error, 'Unknown chat storage error');
  }
}

export async function userRuntimeInitialMessagesAction(args: {
  request: Request;
  env: Env;
  userId: string;
}): Promise<Response> {
  try {
    ensureDataBindings(args.env);
    const body = initialMessagesRequestSchema.parse(
      await readJsonBodyWithLimit(args.request, MAX_INITIAL_MESSAGES_REQUEST_BYTES, 'Initial messages request'),
    );
    if (body.sessionId !== args.userId) {
      throw new UnauthorizedError();
    }
    const chat = await findChat(args.env.DB, { id: body.chatId, sessionId: args.userId });
    if (!chat) {
      return new Response(`Chat not found: ${body.chatId}`, { status: 404 });
    }
    const transcript = await requireChatTranscript(args.env.DB, {
      chatId: chat.id,
      subchatIndex: body.subchatIndex ?? 0,
    });
    const durable = await getBuilderTranscriptSnapshot(args.env, transcriptIdentity(transcript), args.userId);
    if (!durable.checkpoint || durable.checkpoint.revision === 0) {
      return new Response(null, { status: 204, headers: transcriptResponseHeaders(transcript) });
    }
    if (!transcriptIdentitiesEqual(durable.checkpoint, transcriptIdentity(transcript))) {
      return transcriptConflictResponse(durable.checkpoint);
    }
    return Response.json(
      { version: TRANSCRIPT_HISTORY_FORMAT_VERSION, transcript: durable.checkpoint, messages: durable.messages },
      { headers: transcriptResponseHeaders(transcript) },
    );
  } catch (error) {
    return internalErrorResponse(error, 'Unknown initial messages error');
  }
}

function transcriptConflictResponse(checkpoint?: TranscriptCheckpoint | null): Response {
  return Response.json(
    {
      error: 'The agent transcript advanced before this checkpoint was saved. Retry with the latest transcript.',
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
  return retryDurableObjectRpc(() => {
    const stub = env.BuilderAgent.getByName(identity.agentName) as unknown as Pick<
      BuilderAgent,
      'getTranscriptSnapshotForOwner'
    >;
    return stub.getTranscriptSnapshotForOwner(identity, ownerId);
  });
}

function transcriptResponseHeaders(transcript: ChatTranscriptRow): Headers {
  return new Headers({
    'X-Ghostbuild-Transcript-Agent': transcript.agent_name,
    'X-Ghostbuild-Transcript-Generation': transcript.generation.toString(),
    'X-Ghostbuild-Transcript-Subchat': transcript.subchat_index.toString(),
  });
}

function runKnownDataOperation(db: D1Database, path: DataOperationPath, rawArgs: unknown): Promise<unknown> {
  switch (path) {
    case 'messages.initializeChat':
      return initializeChat(db, dataOperationArgSchemas[path].parse(rawArgs));
    case 'messages.discardEmptyChat':
      return discardEmptyChat(db, dataOperationArgSchemas[path].parse(rawArgs));
    case 'messages.get':
      return getChat(db, dataOperationArgSchemas[path].parse(rawArgs));
    case 'messages.getAll':
      return getAllChats(db, dataOperationArgSchemas[path].parse(rawArgs));
    case 'messages.setDescription':
      return setDescription(db, dataOperationArgSchemas[path].parse(rawArgs));
    case 'messages.remove':
      return removeChat(db, dataOperationArgSchemas[path].parse(rawArgs));
    case 'subchats.get':
      return getSubchats(db, dataOperationArgSchemas[path].parse(rawArgs));
    case 'subchats.create':
      return createSubchat(db, dataOperationArgSchemas[path].parse(rawArgs));
    case 'subchats.setDescription':
      return setSubchatDescription(db, dataOperationArgSchemas[path].parse(rawArgs));
    default:
      path satisfies never;
      throw new Error(`Unsupported data operation: ${path}`);
  }
}
