-- Track automatic titles explicitly so later conversation prompts can refresh
-- generated labels without racing or overwriting a manual rename.
ALTER TABLE chats ADD COLUMN description_source TEXT
  CHECK (description_source IN ('heuristic', 'generated', 'user'));

ALTER TABLE chat_transcripts ADD COLUMN description_source TEXT
  CHECK (description_source IN ('heuristic', 'generated', 'user'));

ALTER TABLE chat_transcripts ADD COLUMN description_generation INTEGER NOT NULL DEFAULT 0
  CHECK (description_generation >= 0);

-- Existing labels may have been manually edited. Preserve them conservatively.
UPDATE chats
SET description_source = 'user'
WHERE NULLIF(TRIM(description), '') IS NOT NULL;

UPDATE chat_transcripts
SET description_source = 'user'
WHERE NULLIF(TRIM(description), '') IS NOT NULL;
