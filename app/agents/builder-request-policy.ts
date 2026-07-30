import { transcriptIdentitySchema, type TranscriptIdentity } from 'ghostbuild-agent/transcript';
import { MAX_USER_MESSAGE_CHARACTERS } from 'ghostbuild-agent/context-limits';
import type { UIMessage } from 'ai';

export const MAX_BUILDER_AGENT_MESSAGES = 500;
const MAX_BUILDER_AGENT_NAME_LENGTH = 512;
const MAX_BUILDER_MESSAGE_ID_LENGTH = 512;
const MAX_BUILDER_SUBCHAT_INDEX = 10_000;
export const MAX_BUILDER_MODEL_TRANSCRIPT_BYTES = 4 * 1024 * 1024;

export type BuilderTranscriptBinding = {
  agentName: string;
  chatInitialId: string;
  generation: number;
  subchatIndex: number;
  parentAgentName: string | null;
};

type BuilderTranscriptRow = {
  agent_name: string;
  initial_id: string;
  generation: number;
  subchat_index: number;
  parent_agent_name: string | null;
};

/** Resolve the durable Agent name to the active, owner-scoped D1 transcript it represents. */
export async function loadBuilderTranscriptBinding(
  db: D1Database,
  args: { agentName: string; ownerId: string },
): Promise<BuilderTranscriptBinding | null> {
  const row = await db
    .prepare(
      `SELECT transcripts.agent_name,
              chats.initial_id,
              transcripts.generation,
              transcripts.subchat_index,
              parent.agent_name AS parent_agent_name
       FROM chat_transcripts AS transcripts
       INNER JOIN chats ON chats.id = transcripts.chat_id
       LEFT JOIN chat_transcripts AS parent
         ON parent.chat_id = transcripts.chat_id
        AND parent.subchat_index = transcripts.parent_subchat_index
        AND parent.generation = transcripts.parent_generation
       WHERE transcripts.agent_name = ?
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
        parentAgentName: row.parent_agent_name ?? null,
      }
    : null;
}

export function requireBuilderRequestScope(
  body: Record<string, unknown>,
  binding: BuilderTranscriptBinding | null,
): {
  chatInitialId: string;
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
  const subchatIndex = parseBuilderSubchatIndex(body.subchatIndex);
  const transcript = requireBuilderTranscriptIdentity(body.transcript, binding, subchatIndex);
  if (body.chatInitialId !== binding?.chatInitialId) {
    throw new Response('Initial chat identifier does not match this transcript', { status: 409 });
  }
  return {
    chatInitialId: body.chatInitialId,
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
  let serialized: string;
  try {
    serialized = JSON.stringify(messages);
  } catch {
    throw new Response('Transcript messages must be JSON serializable', { status: 400 });
  }
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > MAX_BUILDER_MODEL_TRANSCRIPT_BYTES) {
    throw new Response('Transcript is too large for a builder turn', { status: 413 });
  }
}

/** Validate and bound a direct client's complete transcript before any durable write or checkpoint hash. */
export function requireBuilderSeedTranscript(value: unknown): UIMessage[] {
  if (!Array.isArray(value)) {
    throw new Response('Invalid transcript messages', { status: 400 });
  }
  if (value.length > MAX_BUILDER_AGENT_MESSAGES) {
    throw new Response('Transcript has too many messages to seed', { status: 413 });
  }

  const messageIds = new Set<string>();
  const messages = value.map((candidate) => {
    const role = (candidate as { role?: unknown } | null)?.role;
    const parts = (candidate as { parts?: unknown } | null)?.parts;
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      typeof (candidate as { id?: unknown }).id !== 'string' ||
      (candidate as { id: string }).id.length === 0 ||
      (candidate as { id: string }).id.length > MAX_BUILDER_MESSAGE_ID_LENGTH ||
      (role !== 'user' && role !== 'assistant' && role !== 'system') ||
      !Array.isArray(parts) ||
      !parts.every(
        (part) =>
          typeof part === 'object' &&
          part !== null &&
          typeof (part as { type?: unknown }).type === 'string' &&
          (part as { type: string }).type.length > 0,
      )
    ) {
      throw new Response('Invalid transcript message shape', { status: 400 });
    }
    const id = (candidate as { id: string }).id;
    if (messageIds.has(id)) {
      throw new Response('Transcript message identifiers must be unique', { status: 400 });
    }
    messageIds.add(id);
    return boundBuilderMessageForPersistence(candidate as UIMessage);
  });

  assertBuilderModelTranscriptWithinLimit(messages);
  return messages;
}

function parseBuilderSubchatIndex(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_BUILDER_SUBCHAT_INDEX) {
    throw new Response('Invalid subchat index', { status: 400 });
  }
  return value as number;
}
