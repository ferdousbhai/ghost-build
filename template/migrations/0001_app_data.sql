CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO decisions (id, title, detail, created_at)
VALUES (
  'stack',
  'Stack',
  'TanStack Start, TanStack DB, TanStack Query, Cloudflare Workers, D1, R2, Workers AI, and Agents.',
  0
);
