UPDATE chats
SET is_deleted = 1
WHERE rowid IN (
  SELECT rowid
  FROM (
    SELECT
      rowid,
      ROW_NUMBER() OVER (
        PARTITION BY creator_id, initial_id
        ORDER BY
          CASE WHEN url_id IS NOT NULL THEN 0 ELSE 1 END,
          timestamp ASC,
          rowid ASC
      ) AS duplicate_chat
    FROM chats
    WHERE is_deleted = 0
  )
  WHERE duplicate_chat > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chats_unique_active_creator_initial
ON chats(creator_id, initial_id)
WHERE is_deleted = 0;
