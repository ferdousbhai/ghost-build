CREATE TABLE IF NOT EXISTS chat_transcripts (
  chat_id TEXT NOT NULL,
  subchat_index INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  agent_name TEXT NOT NULL,
  head_revision INTEGER NOT NULL DEFAULT 0,
  head_digest TEXT,
  head_message_count INTEGER NOT NULL DEFAULT 0,
  parent_subchat_index INTEGER,
  parent_generation INTEGER,
  parent_revision INTEGER,
  transition_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, subchat_index),
  UNIQUE (agent_name)
);

ALTER TABLE chat_message_states ADD COLUMN transcript_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chat_message_states ADD COLUMN transcript_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chat_message_states ADD COLUMN transcript_digest TEXT;

DROP INDEX IF EXISTS idx_chat_message_states_unique_rank;
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_message_states_unique_generation_rank
ON chat_message_states(chat_id, subchat_index, transcript_generation, last_message_rank);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_message_states_unique_transcript_revision
ON chat_message_states(chat_id, subchat_index, transcript_generation, transcript_revision)
WHERE transcript_revision > 0;

INSERT OR IGNORE INTO chat_transcripts (
  chat_id,
  subchat_index,
  generation,
  agent_name,
  head_revision,
  head_digest,
  head_message_count,
  parent_subchat_index,
  parent_generation,
  parent_revision,
  transition_token,
  created_at,
  updated_at
)
SELECT
  states.chat_id,
  states.subchat_index,
  0,
  CASE
    WHEN states.subchat_index = 0 THEN chats.initial_id
    ELSE chats.initial_id || '--transcript-' || states.subchat_index || '-0'
  END,
  MAX(states.transcript_revision),
  NULL,
  0,
  CASE WHEN states.subchat_index > 0 THEN states.subchat_index - 1 ELSE NULL END,
  CASE WHEN states.subchat_index > 0 THEN 0 ELSE NULL END,
  NULL,
  lower(hex(randomblob(16))),
  MIN(states.created_at),
  MAX(states.created_at)
FROM chat_message_states AS states
JOIN chats ON chats.id = states.chat_id
GROUP BY states.chat_id, states.subchat_index, chats.initial_id;
