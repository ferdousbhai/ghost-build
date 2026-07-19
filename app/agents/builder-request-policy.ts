import { transcriptIdentitySchema, type TranscriptIdentity } from 'ghostbuild-agent/transcript';
import { MAX_USER_MESSAGE_CHARACTERS } from 'ghostbuild-agent/context-limits';
import type { UIMessage } from 'ai';

export const MAX_BUILDER_AGENT_MESSAGES = 500;
const MAX_BUILDER_AGENT_NAME_LENGTH = 512;
const MAX_BUILDER_SUBCHAT_INDEX = 10_000;
export const MAX_BUILDER_MODEL_TRANSCRIPT_BYTES = 4 * 1024 * 1024;

export type BuilderTranscriptBinding = {
  agentName: string;
  chatInitialId: string;
  generation: number;
  subchatIndex: number;
};

type BuilderTranscriptRow = {
  agent_name: string;
  initial_id: string;
  generation: number;
  subchat_index: number;
};

/** Resolve the durable Agent name to the active, owner-scoped D1 transcript it represents. */
export async function loadBuilderTranscriptBinding(
  db: D1Database,
  args: { agentName: string; ownerId: string },
): Promise<BuilderTranscriptBinding | null> {
  const row = await db
    .prepare(
      `SELECT chat_transcripts.agent_name,
              chats.initial_id,
              chat_transcripts.generation,
              chat_transcripts.subchat_index
       FROM chat_transcripts
       INNER JOIN chats ON chats.id = chat_transcripts.chat_id
       WHERE chat_transcripts.agent_name = ?
         AND chats.creator_id = ?
         AND chats.is_deleted = 0
       LIMIT 1`,
    )
    .bind(args.agentName, args.ownerId)
    .first<BuilderTranscriptRow>();

  return row
    ? {
        agentName: row.agent_name,
        chatInitialId: row.initial_id,
        generation: row.generation,
        subchatIndex: row.subchat_index,
      }
    : null;
}

export function requireBuilderRequestScope(
  body: Record<string, unknown>,
  binding: BuilderTranscriptBinding | null,
): {
  chatInitialId: string;
  shouldDisableTools: boolean;
  subchatIndex: number;
  transcript: TranscriptIdentity;
} {
  if (
    typeof body.chatInitialId !== 'string' ||
    body.chatInitialId.length === 0 ||
    body.chatInitialId.length > MAX_BUILDER_AGENT_NAME_LENGTH
  ) {
    throw new Response('Invalid initial chat identifier', { status: 400 });
  }
  if (typeof body.shouldDisableTools !== 'boolean') {
    throw new Response('Invalid tool-disable flag', { status: 400 });
  }
  const subchatIndex = parseBuilderSubchatIndex(body.subchatIndex);
  const transcript = requireBuilderTranscriptIdentity(body.transcript, binding, subchatIndex);
  if (body.chatInitialId !== binding?.chatInitialId) {
    throw new Response('Initial chat identifier does not match this transcript', { status: 409 });
  }
  return {
    chatInitialId: body.chatInitialId,
    shouldDisableTools: body.shouldDisableTools,
    subchatIndex,
    transcript,
  };
}

export function requireBuilderTranscriptIdentity(
  value: unknown,
  binding: BuilderTranscriptBinding | null,
  selectedSubchatIndex?: number,
): TranscriptIdentity {
  const result = transcriptIdentitySchema.safeParse(value);
  if (!result.success) {
    throw new Response('Invalid transcript identity', { status: 400 });
  }
  if (
    !binding ||
    result.data.agentName !== binding.agentName ||
    result.data.generation !== binding.generation ||
    result.data.subchatIndex !== binding.subchatIndex
  ) {
    throw new Response('Transcript identity does not match this agent', { status: 409 });
  }
  if (selectedSubchatIndex !== undefined && result.data.subchatIndex !== selectedSubchatIndex) {
    throw new Response('Transcript identity does not match the selected subchat', { status: 409 });
  }
  return result.data;
}

/** Keep direct Agent clients from persisting prompt text beyond the product's supported input size. */
export function boundBuilderMessageForPersistence(message: UIMessage): UIMessage {
  if (message.role !== 'user') {
    return message;
  }
  return {
    ...message,
    parts: message.parts.map((part) =>
      part.type === 'text' && part.text.length > MAX_USER_MESSAGE_CHARACTERS
        ? { ...part, text: part.text.slice(0, MAX_USER_MESSAGE_CHARACTERS) }
        : part,
    ),
  };
}

export function assertBuilderModelTranscriptWithinLimit(messages: unknown[]): void {
  const bytes = new TextEncoder().encode(JSON.stringify(messages)).byteLength;
  if (bytes > MAX_BUILDER_MODEL_TRANSCRIPT_BYTES) {
    throw new Response('Transcript is too large for a builder turn', { status: 413 });
  }
}

function parseBuilderSubchatIndex(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_BUILDER_SUBCHAT_INDEX) {
    throw new Response('Invalid subchat index', { status: 400 });
  }
  return value as number;
}
