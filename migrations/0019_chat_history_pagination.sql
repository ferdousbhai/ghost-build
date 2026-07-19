CREATE INDEX IF NOT EXISTS idx_chats_creator_deleted_history
ON chats(creator_id, is_deleted, timestamp DESC, id DESC);
