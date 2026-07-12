CREATE TABLE IF NOT EXISTS object_gc_candidates (
  storage_key TEXT PRIMARY KEY,
  not_before INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_object_gc_candidates_due
ON object_gc_candidates(not_before, storage_key);

WITH ranked AS (
  SELECT
    rowid,
    chat_id,
    subchat_index,
    last_message_rank,
    ROW_NUMBER() OVER (
      PARTITION BY chat_id, subchat_index, last_message_rank
      ORDER BY part_index DESC, created_at DESC, rowid DESC
    ) AS duplicate_rank,
    COUNT(*) OVER (
      PARTITION BY chat_id, subchat_index, last_message_rank
    ) AS duplicate_count
  FROM chat_message_states
)
UPDATE chat_message_states AS kept
SET
  storage_key = COALESCE(
    kept.storage_key,
    (
      SELECT candidate.storage_key
      FROM chat_message_states AS candidate
      WHERE candidate.chat_id = kept.chat_id
        AND candidate.subchat_index = kept.subchat_index
        AND candidate.last_message_rank = kept.last_message_rank
        AND candidate.storage_key IS NOT NULL
      ORDER BY candidate.part_index DESC, candidate.created_at DESC, candidate.rowid DESC
      LIMIT 1
    )
  ),
  snapshot_key = COALESCE(
    kept.snapshot_key,
    (
      SELECT candidate.snapshot_key
      FROM chat_message_states AS candidate
      WHERE candidate.chat_id = kept.chat_id
        AND candidate.subchat_index = kept.subchat_index
        AND candidate.last_message_rank = kept.last_message_rank
        AND candidate.snapshot_key IS NOT NULL
      ORDER BY candidate.part_index DESC, candidate.created_at DESC, candidate.rowid DESC
      LIMIT 1
    )
  ),
  description = COALESCE(
    kept.description,
    (
      SELECT candidate.description
      FROM chat_message_states AS candidate
      WHERE candidate.chat_id = kept.chat_id
        AND candidate.subchat_index = kept.subchat_index
        AND candidate.last_message_rank = kept.last_message_rank
        AND candidate.description IS NOT NULL
      ORDER BY candidate.part_index DESC, candidate.created_at DESC, candidate.rowid DESC
      LIMIT 1
    )
  )
WHERE kept.rowid IN (
  SELECT rowid FROM ranked WHERE duplicate_rank = 1 AND duplicate_count > 1
);

WITH ranked AS (
  SELECT
    rowid,
    chat_id,
    subchat_index,
    last_message_rank,
    storage_key,
    snapshot_key,
    ROW_NUMBER() OVER (
      PARTITION BY chat_id, subchat_index, last_message_rank
      ORDER BY part_index DESC, created_at DESC, rowid DESC
    ) AS duplicate_rank
  FROM chat_message_states
),
losing_keys AS (
  SELECT storage_key AS storage_key FROM ranked WHERE duplicate_rank > 1 AND storage_key IS NOT NULL
  UNION
  SELECT snapshot_key AS storage_key FROM ranked WHERE duplicate_rank > 1 AND snapshot_key IS NOT NULL
),
kept_keys AS (
  SELECT storage_key AS storage_key FROM ranked WHERE duplicate_rank = 1 AND storage_key IS NOT NULL
  UNION
  SELECT snapshot_key AS storage_key FROM ranked WHERE duplicate_rank = 1 AND snapshot_key IS NOT NULL
)
INSERT OR IGNORE INTO object_gc_candidates (storage_key, not_before, created_at, attempts)
SELECT storage_key, unixepoch('now') * 1000 + 300000, unixepoch('now') * 1000, 0
FROM losing_keys
WHERE storage_key NOT IN (SELECT storage_key FROM kept_keys);

DELETE FROM chat_message_states
WHERE rowid IN (
  SELECT rowid
  FROM (
    SELECT
      rowid,
      ROW_NUMBER() OVER (
        PARTITION BY chat_id, subchat_index, last_message_rank
        ORDER BY part_index DESC, created_at DESC, rowid DESC
      ) AS duplicate_rank
    FROM chat_message_states
  )
  WHERE duplicate_rank > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_message_states_unique_rank
ON chat_message_states(chat_id, subchat_index, last_message_rank);
