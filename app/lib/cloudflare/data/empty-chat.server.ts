export const EMPTY_CHAT_DISCARD_PREDICATE = `chats.is_deleted = 0
  AND NOT EXISTS (
    SELECT 1 FROM chat_transcripts
    WHERE chat_transcripts.chat_id = chats.id AND chat_transcripts.head_revision > 0
  )`;
