import { storageUrl } from './object-storage.server';
import {
  allocateUrlId,
  ensureInitialChat,
  findChat,
  getLatestStorageState,
  requireChat,
} from './chat-repository.server';
import { transcriptAgentName } from 'ghostbuild-agent/transcript';
import { prepareInsertChatTranscript, requireChatTranscript, transcriptIdentity } from './transcript-repository.server';

export async function initializeChat(
  db: D1Database,
  args: { sessionId: string; id: string },
): Promise<{ created: boolean }> {
  const chat = await ensureInitialChat(db, { id: crypto.randomUUID(), creatorId: args.sessionId, initialId: args.id });
  return { created: chat.created };
}

export async function discardEmptyChat(db: D1Database, args: { sessionId: string; id: string }): Promise<null> {
  await db
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
    .bind(args.sessionId, args.id, args.id)
    .run();
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

export async function getAllChats(db: D1Database, args: { sessionId: string }) {
  const { results } = await db
    .prepare(
      `SELECT
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
       ORDER BY chats.timestamp DESC`,
    )
    .bind(args.sessionId)
    .all<{ initial_id: string; url_id: string | null; description: string | null; timestamp: string }>();
  return results.map((row) => ({
    id: row.url_id ?? row.initial_id,
    initialId: row.initial_id,
    urlId: row.url_id ?? undefined,
    description: row.description ?? undefined,
    timestamp: row.timestamp,
  }));
}

export async function setUrlId(
  db: D1Database,
  args: { sessionId: string; chatId: string; urlHint: string; description: string },
) {
  const chat = await requireChat(db, { id: args.chatId, sessionId: args.sessionId });
  if (chat.url_id) {
    return { urlId: chat.url_id, initialId: chat.initial_id };
  }
  const urlId = await allocateUrlId(db, args.sessionId, args.urlHint);
  await db
    .prepare('UPDATE chats SET url_id = ?, description = COALESCE(description, ?) WHERE id = ?')
    .bind(urlId, args.description, chat.id)
    .run();
  return { urlId, initialId: chat.initial_id };
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
    await db.prepare('UPDATE chats SET is_deleted = 1 WHERE id = ?').bind(chat.id).run();
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
  const state = await getLatestStorageState(db, {
    chatId: chat.id,
    subchatIndex,
    lastMessageRank: args.lastMessageRank,
  });
  if (!state?.storage_key) {
    throw new Error('Cannot rewind to a chat with no messages saved');
  }
  const transcript = await requireChatTranscript(db, { chatId: chat.id, subchatIndex });
  const nextGeneration = transcript.generation + 1;
  const now = Date.now();
  const transitionToken = crypto.randomUUID();
  const results = await db.batch([
    db
      .prepare(
        `UPDATE chat_transcripts
         SET generation = ?, agent_name = ?, head_revision = 0, head_digest = NULL, head_message_count = 0,
             parent_subchat_index = ?, parent_generation = ?, parent_revision = ?, transition_token = ?, updated_at = ?
         WHERE chat_id = ? AND subchat_index = ? AND generation = ?`,
      )
      .bind(
        nextGeneration,
        transcriptAgentName(chat.initial_id, subchatIndex, nextGeneration),
        subchatIndex,
        transcript.generation,
        state.transcript_revision,
        transitionToken,
        now,
        chat.id,
        subchatIndex,
        transcript.generation,
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
        crypto.randomUUID(),
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
  if (results[0].meta.changes === 0 || results[1].meta.changes === 0) {
    throw new Error('Chat transcript changed while rewinding; retry the rewind');
  }
  return null;
}

export async function getSubchats(db: D1Database, args: { sessionId: string; chatId: string }) {
  const chat = await requireChat(db, { id: args.chatId, sessionId: args.sessionId });
  const { results } = await db
    .prepare(
      `SELECT states.subchat_index, states.description, MAX(states.created_at) AS updated_at,
              transcripts.generation, transcripts.agent_name
       FROM chat_message_states AS states
       JOIN chat_transcripts AS transcripts
         ON transcripts.chat_id = states.chat_id AND transcripts.subchat_index = states.subchat_index
       WHERE states.chat_id = ? AND states.transcript_generation = transcripts.generation
       GROUP BY states.subchat_index, transcripts.generation, transcripts.agent_name
       ORDER BY states.subchat_index ASC`,
    )
    .bind(chat.id)
    .all<{
      subchat_index: number;
      description: string | null;
      updated_at: number;
      generation: number;
      agent_name: string;
    }>();
  return results.map((row) => ({
    subchatIndex: row.subchat_index,
    description: row.description ?? undefined,
    updatedAt: row.updated_at,
    transcript: {
      agentName: row.agent_name,
      generation: row.generation,
      subchatIndex: row.subchat_index,
    },
  }));
}

export async function createSubchat(db: D1Database, args: { sessionId: string; chatId: string }) {
  const chat = await requireChat(db, { id: args.chatId, sessionId: args.sessionId });
  const newSubchatIndex = chat.last_subchat_index + 1;
  const latestState = await getLatestStorageState(db, { chatId: chat.id, subchatIndex: chat.last_subchat_index });
  const parentTranscript = await requireChatTranscript(db, {
    chatId: chat.id,
    subchatIndex: chat.last_subchat_index,
  });
  const now = Date.now();
  await db.batch([
    prepareInsertChatTranscript(db, {
      chatId: chat.id,
      initialId: chat.initial_id,
      subchatIndex: newSubchatIndex,
      parent: {
        subchatIndex: parentTranscript.subchat_index,
        generation: parentTranscript.generation,
        revision: latestState?.transcript_revision ?? parentTranscript.head_revision,
      },
      now,
    }),
    db
      .prepare(
        `INSERT INTO chat_message_states (
          id, chat_id, storage_key, subchat_index, last_message_rank, part_index,
          snapshot_key, description, created_at, transcript_generation, transcript_revision, transcript_digest
        ) VALUES (?, ?, NULL, ?, -1, -1, ?, NULL, ?, 0, 0, NULL)`,
      )
      .bind(crypto.randomUUID(), chat.id, newSubchatIndex, latestState?.snapshot_key ?? null, now),
    db.prepare('UPDATE chats SET last_subchat_index = ? WHERE id = ?').bind(newSubchatIndex, chat.id),
  ]);
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
