import { storageUrl } from './object-storage.server';
import {
  claimChatUrlId,
  ensureInitialChat,
  findChat,
  getLatestStorageState,
  getLatestStorageStateForGeneration,
  requireChat,
} from './chat-repository.server';
import { transcriptAgentName } from 'ghostbuild-agent/transcript';
import { prepareInsertChatTranscript, requireChatTranscript, transcriptIdentity } from './transcript-repository.server';
import { prepareChatObjectGcCandidatesStatement } from './object-gc.server';
import { prepareChatAgentGcCandidatesStatement, prepareEmptyChatAgentGcCandidatesStatement } from './agent-gc.server';
import {
  boundedDataPageSize,
  MAX_SUBCHAT_INDEX,
  type ChatHistoryCursor,
  type SubchatCursor,
} from '~/lib/cloudflare/data-pagination';
import { SubchatLimitError } from './errors';

export async function initializeChat(
  db: D1Database,
  args: { sessionId: string; id: string },
): Promise<{ created: boolean }> {
  const chat = await ensureInitialChat(db, { id: crypto.randomUUID(), creatorId: args.sessionId, initialId: args.id });
  return { created: chat.created };
}

export async function discardEmptyChat(db: D1Database, args: { sessionId: string; id: string }): Promise<null> {
  await db.batch([
    prepareEmptyChatAgentGcCandidatesStatement(db, { ownerId: args.sessionId, id: args.id }),
    db
      .prepare(
        `UPDATE chats
         SET is_deleted = 1
         WHERE creator_id = ? AND (initial_id = ? OR url_id = ?) AND is_deleted = 0
           AND url_id IS NULL AND NULLIF(TRIM(description), '') IS NULL AND snapshot_key IS NULL
           AND (last_message_rank IS NULL OR last_message_rank < 0)
           AND NOT EXISTS (
             SELECT 1 FROM chat_message_states
             WHERE chat_message_states.chat_id = chats.id AND chat_message_states.last_message_rank >= 0
           )`,
      )
      .bind(args.sessionId, args.id, args.id),
  ]);
  return null;
}

export async function getChat(db: D1Database, args: { id: string; sessionId: string; subchatIndex?: number }) {
  const chat = await findChat(db, args);
  if (!chat) {
    return null;
  }
  const selectedSubchatIndex = args.subchatIndex ?? chat.last_subchat_index;
  const transcript = await requireChatTranscript(db, { chatId: chat.id, subchatIndex: selectedSubchatIndex });
  return {
    initialId: chat.initial_id,
    urlId: chat.url_id ?? undefined,
    description: chat.description ?? undefined,
    timestamp: chat.timestamp,
    snapshotId: chat.snapshot_key ?? undefined,
    subchatIndex: chat.last_subchat_index,
    transcript: transcriptIdentity(transcript),
  };
}

export async function getAllChats(
  db: D1Database,
  args: { sessionId: string; cursor?: ChatHistoryCursor; limit?: number },
) {
  const limit = boundedDataPageSize(args.limit);
  const cursorClause = args.cursor ? 'AND (chats.timestamp, chats.id) < (?, ?)' : '';
  const { results } = await db
    .prepare(
      `SELECT
         chats.id AS row_id,
         chats.initial_id,
         chats.url_id,
         COALESCE(
           NULLIF(TRIM(chats.description), ''),
           (
             SELECT NULLIF(TRIM(chat_message_states.description), '')
             FROM chat_message_states
             WHERE chat_message_states.chat_id = chats.id
               AND chat_message_states.description IS NOT NULL
               AND TRIM(chat_message_states.description) <> ''
             ORDER BY
               chat_message_states.subchat_index ASC,
               chat_message_states.last_message_rank ASC,
               chat_message_states.part_index ASC
             LIMIT 1
           )
         ) AS description,
         chats.timestamp
       FROM chats
       WHERE chats.creator_id = ? AND chats.is_deleted = 0
         AND EXISTS (
           SELECT 1 FROM chat_message_states
           WHERE chat_message_states.chat_id = chats.id AND chat_message_states.last_message_rank >= 0
         )
         ${cursorClause}
       ORDER BY chats.timestamp DESC, chats.id DESC
       LIMIT ?`,
    )
    .bind(args.sessionId, ...(args.cursor ? [args.cursor.timestamp, args.cursor.rowId] : []), limit + 1)
    .all<{
      row_id: string;
      initial_id: string;
      url_id: string | null;
      description: string | null;
      timestamp: string;
    }>();
  const pageRows = results.slice(0, limit);
  const lastRow = pageRows.at(-1);
  return {
    items: pageRows.map((row) => ({
      id: row.url_id ?? row.initial_id,
      initialId: row.initial_id,
      urlId: row.url_id ?? undefined,
      description: row.description ?? undefined,
      timestamp: row.timestamp,
    })),
    nextCursor:
      results.length > limit && lastRow
        ? {
            timestamp: lastRow.timestamp,
            rowId: lastRow.row_id,
          }
        : undefined,
  };
}

export async function setUrlId(
  db: D1Database,
  args: { sessionId: string; chatId: string; urlHint: string; description: string },
) {
  const chat = await requireChat(db, { id: args.chatId, sessionId: args.sessionId });
  if (chat.url_id) {
    return { urlId: chat.url_id, initialId: chat.initial_id };
  }
  return claimChatUrlId(db, {
    chatId: chat.id,
    ownerId: args.sessionId,
    urlHint: args.urlHint,
    description: args.description,
  });
}

export async function setDescription(
  db: D1Database,
  args: { sessionId: string; id: string; description: string },
): Promise<null> {
  const chat = await requireChat(db, { id: args.id, sessionId: args.sessionId });
  await db.prepare('UPDATE chats SET description = ? WHERE id = ?').bind(args.description, chat.id).run();
  return null;
}

export async function setGeneratedDescriptionIfMissing(
  db: D1Database,
  args: { sessionId: string; id: string; description: string },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE chats
       SET description = ?
       WHERE creator_id = ? AND (initial_id = ? OR url_id = ?) AND is_deleted = 0
         AND NULLIF(TRIM(description), '') IS NULL`,
    )
    .bind(args.description, args.sessionId, args.id, args.id)
    .run();
  return result.meta.changes > 0;
}

export async function removeChat(db: D1Database, args: { sessionId: string; id: string }) {
  const chat = await findChat(db, { id: args.id, sessionId: args.sessionId });
  if (chat) {
    await db.batch([
      prepareChatObjectGcCandidatesStatement(db, { chatId: chat.id, ownerId: args.sessionId }),
      prepareChatAgentGcCandidatesStatement(db, { chatId: chat.id, ownerId: args.sessionId }),
      db
        .prepare(
          `UPDATE chats
           SET is_deleted = 1, snapshot_key = NULL
           WHERE id = ? AND creator_id = ? AND is_deleted = 0`,
        )
        .bind(chat.id, args.sessionId),
      db.prepare('DELETE FROM shares WHERE chat_id = ?').bind(chat.id),
      db.prepare('DELETE FROM social_shares WHERE chat_id = ?').bind(chat.id),
      db.prepare('DELETE FROM chat_message_states WHERE chat_id = ?').bind(chat.id),
    ]);
  }
  return { kind: 'success' } as const;
}

export async function earliestRewindableMessageRank(
  db: D1Database,
  args: { sessionId: string; chatId: string; subchatIndex?: number },
): Promise<number | null> {
  const chat = await requireChat(db, { id: args.chatId, sessionId: args.sessionId });
  const subchatIndex = args.subchatIndex ?? chat.last_subchat_index;
  const row = await db
    .prepare(
      `SELECT last_message_rank
       FROM chat_message_states
       WHERE chat_id = ? AND subchat_index = ? AND snapshot_key IS NOT NULL
       ORDER BY last_message_rank ASC, part_index ASC
       LIMIT 1`,
    )
    .bind(chat.id, subchatIndex)
    .first<{ last_message_rank: number }>();
  return row?.last_message_rank ?? null;
}

export async function rewindChat(
  db: D1Database,
  args: { sessionId: string; chatId: string; subchatIndex?: number; lastMessageRank?: number },
): Promise<null> {
  const chat = await requireChat(db, { id: args.chatId, sessionId: args.sessionId });
  const subchatIndex = args.subchatIndex ?? 0;
  const transcript = await requireChatTranscript(db, { chatId: chat.id, subchatIndex });
  const state = await getLatestStorageStateForGeneration(db, {
    chatId: chat.id,
    subchatIndex,
    generation: transcript.generation,
    lastMessageRank: args.lastMessageRank,
  });
  if (!state?.storage_key) {
    throw new Error('Cannot rewind to a chat with no messages saved');
  }
  const nextGeneration = transcript.generation + 1;
  const nextAgentName = transcriptAgentName(chat.initial_id, subchatIndex, nextGeneration);
  const now = Date.now();
  const transitionToken = crypto.randomUUID();
  const stateId = crypto.randomUUID();
  let results: D1Result[];
  try {
    results = await db.batch([
      db
        .prepare(
          `UPDATE chat_transcripts
           SET generation = ?, agent_name = ?, head_revision = 0, head_digest = NULL, head_message_count = 0,
               parent_subchat_index = ?, parent_generation = ?, parent_revision = ?, transition_token = ?, updated_at = ?
           WHERE chat_id = ? AND subchat_index = ? AND generation = ?
             AND EXISTS (
               SELECT 1 FROM chats
               WHERE chats.id = chat_transcripts.chat_id AND chats.creator_id = ? AND chats.is_deleted = 0
             )`,
        )
        .bind(
          nextGeneration,
          nextAgentName,
          subchatIndex,
          transcript.generation,
          state.transcript_revision,
          transitionToken,
          now,
          chat.id,
          subchatIndex,
          transcript.generation,
          args.sessionId,
        ),
      db
        .prepare(
          `INSERT INTO chat_message_states (
            id, chat_id, storage_key, subchat_index, last_message_rank, part_index,
            snapshot_key, description, created_at, transcript_generation, transcript_revision, transcript_digest
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL
          FROM chat_transcripts
          WHERE chat_id = ? AND subchat_index = ? AND generation = ? AND transition_token = ?`,
        )
        .bind(
          stateId,
          chat.id,
          state.storage_key,
          subchatIndex,
          state.last_message_rank,
          state.part_index,
          state.snapshot_key,
          state.description,
          now,
          nextGeneration,
          chat.id,
          subchatIndex,
          nextGeneration,
          transitionToken,
        ),
      db
        .prepare(
          `UPDATE chats
           SET last_subchat_index = ?, last_message_rank = ?
           WHERE id = ? AND EXISTS (
             SELECT 1 FROM chat_transcripts
             WHERE chat_id = ? AND subchat_index = ? AND generation = ? AND transition_token = ?
           )`,
        )
        .bind(subchatIndex, state.last_message_rank, chat.id, chat.id, subchatIndex, nextGeneration, transitionToken),
    ]);
  } catch (error) {
    try {
      const committed = await db
        .prepare(
          `SELECT 1 AS found
           FROM chats
           JOIN chat_transcripts AS transcripts ON transcripts.chat_id = chats.id
           JOIN chat_message_states AS states ON states.chat_id = chats.id
           WHERE chats.id = ? AND chats.creator_id = ? AND chats.is_deleted = 0
             AND chats.last_subchat_index = ? AND chats.last_message_rank = ?
             AND transcripts.subchat_index = ? AND transcripts.generation = ?
             AND transcripts.agent_name = ? AND transcripts.transition_token = ?
             AND transcripts.head_revision = 0 AND transcripts.head_digest IS NULL
             AND transcripts.head_message_count = 0
             AND transcripts.parent_subchat_index = ? AND transcripts.parent_generation = ?
             AND transcripts.parent_revision = ?
             AND states.id = ? AND states.subchat_index = ? AND states.transcript_generation = ?
             AND states.storage_key IS ? AND states.last_message_rank = ? AND states.part_index = ?
             AND states.snapshot_key IS ? AND states.description IS ?
             AND states.transcript_revision = 0 AND states.transcript_digest IS NULL
           LIMIT 1`,
        )
        .bind(
          chat.id,
          args.sessionId,
          subchatIndex,
          state.last_message_rank,
          subchatIndex,
          nextGeneration,
          nextAgentName,
          transitionToken,
          subchatIndex,
          transcript.generation,
          state.transcript_revision,
          stateId,
          subchatIndex,
          nextGeneration,
          state.storage_key,
          state.last_message_rank,
          state.part_index,
          state.snapshot_key,
          state.description,
        )
        .first<{ found: number }>();
      if (committed) {
        return null;
      }
    } catch {
      // Preserve the original batch failure when the commit receipt cannot be read.
    }
    throw error;
  }
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new Error('Chat transcript changed while rewinding; retry the rewind');
  }
  return null;
}

export async function getSubchats(
  db: D1Database,
  args: { sessionId: string; chatId: string; cursor?: SubchatCursor; limit?: number },
) {
  const chat = await requireChat(db, { id: args.chatId, sessionId: args.sessionId });
  const limit = boundedDataPageSize(args.limit);
  const cursorSubchatIndex = args.cursor?.subchatIndex ?? -1;
  const { results } = await db
    .prepare(
      `SELECT states.subchat_index, states.description, MAX(states.created_at) AS updated_at,
              transcripts.generation, transcripts.agent_name
       FROM chat_message_states AS states
       JOIN chat_transcripts AS transcripts
         ON transcripts.chat_id = states.chat_id AND transcripts.subchat_index = states.subchat_index
       WHERE states.chat_id = ? AND states.transcript_generation = transcripts.generation
         AND states.subchat_index > ?
       GROUP BY states.subchat_index, transcripts.generation, transcripts.agent_name
       ORDER BY states.subchat_index ASC
       LIMIT ?`,
    )
    .bind(chat.id, cursorSubchatIndex, limit + 1)
    .all<{
      subchat_index: number;
      description: string | null;
      updated_at: number;
      generation: number;
      agent_name: string;
    }>();
  const pageRows = results.slice(0, limit);
  const lastRow = pageRows.at(-1);
  return {
    items: pageRows.map((row) => ({
      subchatIndex: row.subchat_index,
      description: row.description ?? undefined,
      updatedAt: row.updated_at,
      transcript: {
        agentName: row.agent_name,
        generation: row.generation,
        subchatIndex: row.subchat_index,
      },
    })),
    nextCursor:
      results.length > limit && lastRow
        ? {
            subchatIndex: lastRow.subchat_index,
          }
        : undefined,
  };
}

export async function createSubchat(db: D1Database, args: { sessionId: string; chatId: string }) {
  const chat = await requireChat(db, { id: args.chatId, sessionId: args.sessionId });
  if (chat.last_subchat_index >= MAX_SUBCHAT_INDEX) {
    throw new SubchatLimitError();
  }
  const newSubchatIndex = chat.last_subchat_index + 1;
  const parentTranscript = await requireChatTranscript(db, {
    chatId: chat.id,
    subchatIndex: chat.last_subchat_index,
  });
  const latestState = await getLatestStorageStateForGeneration(db, {
    chatId: chat.id,
    subchatIndex: chat.last_subchat_index,
    generation: parentTranscript.generation,
  });
  const now = Date.now();
  const transitionToken = crypto.randomUUID();
  const parentRevision = latestState?.transcript_revision ?? parentTranscript.head_revision;
  const snapshotKey = latestState?.snapshot_key ?? null;
  const agentName = transcriptAgentName(chat.initial_id, newSubchatIndex, 0);
  const stateId = crypto.randomUUID();
  let results: D1Result[];
  try {
    results = await db.batch([
      prepareInsertChatTranscript(db, {
        chatId: chat.id,
        initialId: chat.initial_id,
        subchatIndex: newSubchatIndex,
        parent: {
          subchatIndex: parentTranscript.subchat_index,
          generation: parentTranscript.generation,
          revision: parentRevision,
        },
        ownerId: args.sessionId,
        transitionToken,
        now,
      }),
      db
        .prepare(
          `INSERT INTO chat_message_states (
            id, chat_id, storage_key, subchat_index, last_message_rank, part_index,
            snapshot_key, description, created_at, transcript_generation, transcript_revision, transcript_digest
          )
          SELECT ?, ?, NULL, ?, -1, -1, ?, NULL, ?, 0, 0, NULL
          FROM chat_transcripts
          WHERE chat_id = ? AND subchat_index = ? AND generation = 0 AND transition_token = ?`,
        )
        .bind(stateId, chat.id, newSubchatIndex, snapshotKey, now, chat.id, newSubchatIndex, transitionToken),
      db
        .prepare(
          `UPDATE chats
           SET last_subchat_index = ?
           WHERE id = ? AND last_subchat_index = ? AND EXISTS (
             SELECT 1 FROM chat_transcripts
             WHERE chat_id = ? AND subchat_index = ? AND generation = 0 AND transition_token = ?
           )`,
        )
        .bind(newSubchatIndex, chat.id, chat.last_subchat_index, chat.id, newSubchatIndex, transitionToken),
    ]);
  } catch (error) {
    try {
      const committed = await db
        .prepare(
          `SELECT 1 AS found
           FROM chats
           JOIN chat_transcripts AS transcripts ON transcripts.chat_id = chats.id
           JOIN chat_message_states AS states ON states.chat_id = chats.id
           WHERE chats.id = ? AND chats.creator_id = ? AND chats.is_deleted = 0
             AND chats.last_subchat_index = ?
             AND transcripts.subchat_index = ? AND transcripts.generation = 0
             AND transcripts.agent_name = ? AND transcripts.transition_token = ?
             AND transcripts.head_revision = 0 AND transcripts.head_digest IS NULL
             AND transcripts.head_message_count = 0
             AND transcripts.parent_subchat_index = ? AND transcripts.parent_generation = ?
             AND transcripts.parent_revision = ?
             AND states.id = ? AND states.subchat_index = ? AND states.transcript_generation = 0
             AND states.storage_key IS NULL AND states.last_message_rank = -1 AND states.part_index = -1
             AND states.snapshot_key IS ? AND states.description IS NULL
             AND states.transcript_revision = 0 AND states.transcript_digest IS NULL
           LIMIT 1`,
        )
        .bind(
          chat.id,
          args.sessionId,
          newSubchatIndex,
          newSubchatIndex,
          agentName,
          transitionToken,
          parentTranscript.subchat_index,
          parentTranscript.generation,
          parentRevision,
          stateId,
          newSubchatIndex,
          snapshotKey,
        )
        .first<{ found: number }>();
      if (committed) {
        return newSubchatIndex;
      }
    } catch {
      // Preserve the original batch failure when the commit receipt cannot be read.
    }
    throw error;
  }
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new Error('Chat transcript changed while creating a subchat; retry the operation');
  }
  return newSubchatIndex;
}

export async function getSnapshotUrl(env: Env, args: { sessionId: string; chatId: string }): Promise<string | null> {
  const chat = await requireChat(env.DB, { id: args.chatId, sessionId: args.sessionId });
  const latestState = await getLatestStorageState(env.DB, {
    chatId: chat.id,
    subchatIndex: chat.last_subchat_index,
  });
  const key = latestState?.snapshot_key ?? chat.snapshot_key;
  return key ? storageUrl(key) : null;
}
