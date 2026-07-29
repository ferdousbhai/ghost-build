export const EMPTY_CHAT_DISCARD_PREDICATE = `chats.is_deleted = 0
  AND chats.url_id IS NULL
  AND chats.snapshot_key IS NULL
  AND (chats.last_message_rank IS NULL OR chats.last_message_rank < 0)
  AND NOT EXISTS (
    SELECT 1 FROM chat_message_states
    WHERE chat_message_states.chat_id = chats.id AND chat_message_states.last_message_rank >= 0
  )`;
