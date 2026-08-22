-- BuilderAgent Durable Object SQLite is the sole transcript/checkpoint store.
-- D1 retains only catalog visibility, transcript identity, and branch ancestry.
ALTER TABLE chats ADD COLUMN has_messages INTEGER NOT NULL DEFAULT 0
  CHECK (has_messages IN (0, 1));

UPDATE chats
SET has_messages = 1
WHERE EXISTS (
  SELECT 1 FROM chat_transcripts
  WHERE chat_transcripts.chat_id = chats.id AND chat_transcripts.head_revision > 0
);

CREATE TABLE chat_transcripts_v2 (
  chat_id TEXT NOT NULL,
  subchat_index INTEGER NOT NULL CHECK (subchat_index >= 0),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  agent_name TEXT NOT NULL UNIQUE,
  description TEXT,
  parent_subchat_index INTEGER,
  parent_generation INTEGER,
  parent_revision INTEGER,
  transition_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  description_source TEXT CHECK (description_source IN ('heuristic', 'generated', 'user')),
  description_generation INTEGER NOT NULL DEFAULT 0 CHECK (description_generation >= 0),
  PRIMARY KEY (chat_id, subchat_index),
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);

INSERT INTO chat_transcripts_v2 (
  chat_id, subchat_index, generation, agent_name, description,
  parent_subchat_index, parent_generation, parent_revision, transition_token,
  created_at, updated_at, description_source, description_generation
)
SELECT
  chat_id, subchat_index, generation, agent_name, description,
  parent_subchat_index, parent_generation, parent_revision, transition_token,
  created_at, updated_at, description_source, description_generation
FROM chat_transcripts;

DROP TABLE chat_transcripts;
ALTER TABLE chat_transcripts_v2 RENAME TO chat_transcripts;
