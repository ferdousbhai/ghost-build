WITH ranked AS (
  SELECT
    rowid,
    ROW_NUMBER() OVER (
      PARTITION BY creator_id, url_id
      ORDER BY timestamp ASC, rowid ASC
    ) AS duplicate_url
  FROM chats
  WHERE is_deleted = 0 AND url_id IS NOT NULL
)
UPDATE chats
SET url_id = NULL
WHERE rowid IN (SELECT rowid FROM ranked WHERE duplicate_url > 1);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chats_unique_active_creator_url
ON chats(creator_id, url_id)
WHERE is_deleted = 0 AND url_id IS NOT NULL;
