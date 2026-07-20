CREATE TABLE IF NOT EXISTS agent_gc_candidates (
  chat_id TEXT NOT NULL,
  initial_id TEXT NOT NULL,
  subchat_index INTEGER NOT NULL CHECK (subchat_index >= 0),
  next_generation INTEGER NOT NULL DEFAULT 0 CHECK (next_generation >= 0),
  max_generation INTEGER NOT NULL CHECK (max_generation >= next_generation),
  not_before INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  PRIMARY KEY (chat_id, subchat_index)
);

CREATE INDEX IF NOT EXISTS idx_agent_gc_candidates_due
ON agent_gc_candidates(not_before, chat_id, subchat_index);

-- Queue transcripts retained by chats deleted before this outbox existed. One
-- row represents the inclusive generation range for a subchat, keeping the
-- migration and each later sweep bounded independently of rewind history.
INSERT OR IGNORE INTO agent_gc_candidates (
  chat_id,
  initial_id,
  subchat_index,
  next_generation,
  max_generation,
  not_before,
  created_at,
  attempts
)
SELECT
  chats.id,
  chats.initial_id,
  transcripts.subchat_index,
  0,
  transcripts.generation,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 1800000,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  0
FROM chats
JOIN chat_transcripts AS transcripts ON transcripts.chat_id = chats.id
WHERE chats.is_deleted = 1;
