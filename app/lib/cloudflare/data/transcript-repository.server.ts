import {
  transcriptAgentName,
  transcriptIdentitiesEqual,
  type TranscriptCheckpoint,
  type TranscriptIdentity,
} from 'ghostbuild-agent/transcript';
import type { ChatTranscriptRow } from './types';

export async function requireChatTranscript(
  db: D1Database,
  args: { chatId: string; subchatIndex: number },
): Promise<ChatTranscriptRow> {
  const transcript = await db
    .prepare('SELECT * FROM chat_transcripts WHERE chat_id = ? AND subchat_index = ?')
    .bind(args.chatId, args.subchatIndex)
    .first<ChatTranscriptRow>();
  if (!transcript) {
    throw new Error('Chat transcript not found');
  }
  return transcript;
}

export function transcriptIdentity(row: ChatTranscriptRow): TranscriptIdentity {
  return {
    agentName: row.agent_name,
    generation: row.generation,
    subchatIndex: row.subchat_index,
  };
}

export function prepareInsertChatTranscript(
  db: D1Database,
  args: {
    chatId: string;
    initialId: string;
    subchatIndex: number;
    generation?: number;
    headRevision?: number;
    headDigest?: string | null;
    parent?: { subchatIndex: number; generation: number; revision: number } | null;
    transitionToken?: string;
    now?: number;
  },
): D1PreparedStatement {
  const generation = args.generation ?? 0;
  const now = args.now ?? Date.now();
  return db
    .prepare(
      `INSERT INTO chat_transcripts (
        chat_id, subchat_index, generation, agent_name, head_revision, head_digest, head_message_count,
        parent_subchat_index, parent_generation, parent_revision, transition_token, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      args.chatId,
      args.subchatIndex,
      generation,
      transcriptAgentName(args.initialId, args.subchatIndex, generation),
      args.headRevision ?? 0,
      args.headDigest ?? null,
      0,
      args.parent?.subchatIndex ?? null,
      args.parent?.generation ?? null,
      args.parent?.revision ?? null,
      args.transitionToken ?? crypto.randomUUID(),
      now,
      now,
    );
}

export function checkpointMatchesIdentity(checkpoint: TranscriptCheckpoint, transcript: ChatTranscriptRow): boolean {
  return transcriptIdentitiesEqual(checkpoint, transcriptIdentity(transcript));
}
