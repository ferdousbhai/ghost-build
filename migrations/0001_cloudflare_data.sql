CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL,
  initial_id TEXT NOT NULL,
  url_id TEXT,
  description TEXT,
  timestamp TEXT NOT NULL,
  snapshot_key TEXT,
  last_message_rank INTEGER,
  last_subchat_index INTEGER NOT NULL DEFAULT 0,
  is_deleted INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_chats_creator_initial_deleted ON chats(creator_id, initial_id, is_deleted);
CREATE INDEX IF NOT EXISTS idx_chats_creator_url_deleted ON chats(creator_id, url_id, is_deleted);
CREATE INDEX IF NOT EXISTS idx_chats_initial_deleted ON chats(initial_id, is_deleted);
CREATE INDEX IF NOT EXISTS idx_chats_snapshot_key ON chats(snapshot_key);

CREATE TABLE IF NOT EXISTS chat_message_states (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  storage_key TEXT,
  subchat_index INTEGER NOT NULL,
  last_message_rank INTEGER NOT NULL,
  part_index INTEGER NOT NULL,
  snapshot_key TEXT,
  description TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_message_states_chat ON chat_message_states(
  chat_id,
  subchat_index,
  last_message_rank,
  part_index
);
CREATE INDEX IF NOT EXISTS idx_chat_message_states_storage_key ON chat_message_states(storage_key);
CREATE INDEX IF NOT EXISTS idx_chat_message_states_snapshot_key ON chat_message_states(snapshot_key);

CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  snapshot_key TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  chat_history_key TEXT,
  last_message_rank INTEGER NOT NULL,
  last_subchat_index INTEGER NOT NULL,
  part_index INTEGER,
  description TEXT
);

CREATE INDEX IF NOT EXISTS idx_shares_code ON shares(code);
CREATE INDEX IF NOT EXISTS idx_shares_chat_id ON shares(chat_id);
CREATE INDEX IF NOT EXISTS idx_shares_snapshot_key ON shares(snapshot_key);
CREATE INDEX IF NOT EXISTS idx_shares_chat_history_key ON shares(chat_history_key);

CREATE TABLE IF NOT EXISTS social_shares (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  thumbnail_image_key TEXT,
  is_shared INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_social_shares_code ON social_shares(code);
CREATE INDEX IF NOT EXISTS idx_social_shares_chat_id ON social_shares(chat_id);
CREATE INDEX IF NOT EXISTS idx_social_shares_thumbnail_key ON social_shares(thumbnail_image_key);
