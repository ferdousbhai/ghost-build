WITH ranked AS (
  SELECT
    rowid,
    chat_id,
    ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY rowid DESC) AS duplicate_rank,
    COUNT(*) OVER (PARTITION BY chat_id) AS duplicate_count
  FROM social_shares
)
UPDATE social_shares AS kept
SET
  thumbnail_image_key = COALESCE(
    kept.thumbnail_image_key,
    (
      SELECT candidate.thumbnail_image_key
      FROM social_shares AS candidate
      WHERE candidate.chat_id = kept.chat_id
        AND candidate.thumbnail_image_key IS NOT NULL
      ORDER BY candidate.rowid DESC
      LIMIT 1
    )
  ),
  is_shared = (
    SELECT MAX(candidate.is_shared)
    FROM social_shares AS candidate
    WHERE candidate.chat_id = kept.chat_id
  )
WHERE kept.rowid IN (
  SELECT rowid FROM ranked WHERE duplicate_rank = 1 AND duplicate_count > 1
);

WITH ranked AS (
  SELECT
    rowid,
    chat_id,
    thumbnail_image_key,
    ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY rowid DESC) AS duplicate_rank
  FROM social_shares
),
losing_keys AS (
  SELECT thumbnail_image_key AS storage_key
  FROM ranked
  WHERE duplicate_rank > 1 AND thumbnail_image_key IS NOT NULL
),
kept_keys AS (
  SELECT thumbnail_image_key AS storage_key
  FROM ranked
  WHERE duplicate_rank = 1 AND thumbnail_image_key IS NOT NULL
)
INSERT OR IGNORE INTO object_gc_candidates (storage_key, not_before, created_at, attempts)
SELECT DISTINCT storage_key, unixepoch('now') * 1000 + 300000, unixepoch('now') * 1000, 0
FROM losing_keys
WHERE storage_key NOT IN (SELECT storage_key FROM kept_keys);

DELETE FROM social_shares
WHERE rowid IN (
  SELECT rowid
  FROM (
    SELECT
      rowid,
      ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY rowid DESC) AS duplicate_rank
    FROM social_shares
  )
  WHERE duplicate_rank > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_social_shares_unique_chat
ON social_shares(chat_id);
