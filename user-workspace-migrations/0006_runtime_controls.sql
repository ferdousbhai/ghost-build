-- Operator kill switch for the preview-only @cloudflare/computer runtime.
-- Setting enabled to 0 stops the runtime from admitting new Computer-backed
-- operations without redeploying it. Durable project data stays readable.
CREATE TABLE runtime_controls (
  key TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  reason TEXT,
  updated_at INTEGER NOT NULL
);

INSERT INTO runtime_controls (key, enabled, reason, updated_at)
VALUES ('computer_operations', 1, NULL, unixepoch() * 1000);
