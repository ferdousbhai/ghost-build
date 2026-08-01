CREATE TABLE chats (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL,
  initial_id TEXT NOT NULL,
  url_id TEXT,
  description TEXT,
  timestamp TEXT NOT NULL,
  last_subchat_index INTEGER NOT NULL DEFAULT 0,
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1))
);

CREATE UNIQUE INDEX idx_chats_active_initial
ON chats(creator_id, initial_id) WHERE is_deleted = 0;
CREATE UNIQUE INDEX idx_chats_active_url
ON chats(creator_id, url_id) WHERE is_deleted = 0 AND url_id IS NOT NULL;
CREATE INDEX idx_chats_history
ON chats(creator_id, is_deleted, timestamp DESC, id DESC);

CREATE TABLE chat_transcripts (
  chat_id TEXT NOT NULL,
  subchat_index INTEGER NOT NULL CHECK (subchat_index >= 0),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  agent_name TEXT NOT NULL UNIQUE,
  head_revision INTEGER NOT NULL DEFAULT 0 CHECK (head_revision >= 0),
  head_digest TEXT,
  head_message_count INTEGER NOT NULL DEFAULT 0 CHECK (head_message_count >= 0),
  last_message_rank INTEGER NOT NULL DEFAULT -1 CHECK (last_message_rank >= -1),
  part_index INTEGER NOT NULL DEFAULT -1 CHECK (part_index >= -1),
  description TEXT,
  parent_subchat_index INTEGER,
  parent_generation INTEGER,
  parent_revision INTEGER,
  transition_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, subchat_index),
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);

CREATE TABLE agent_gc_candidates (
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

CREATE INDEX idx_agent_gc_due
ON agent_gc_candidates(not_before, chat_id, subchat_index);

CREATE TABLE deployments (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  connection_generation INTEGER NOT NULL CHECK (connection_generation > 0),
  execution_generation INTEGER NOT NULL DEFAULT 0 CHECK (execution_generation >= 0),
  workspace_reference TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('awaiting_approval', 'approved', 'provisioning', 'deploying', 'succeeded', 'failed')
  ),
  plan_json TEXT NOT NULL,
  plan_digest TEXT NOT NULL,
  approved_digest TEXT,
  approved_at INTEGER,
  production_url TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);

CREATE INDEX idx_deployments_user_created
ON deployments(user_id, created_at DESC);
CREATE INDEX idx_deployments_chat_created
ON deployments(chat_id, created_at DESC);
CREATE INDEX idx_deployments_status_updated
ON deployments(status, updated_at);

CREATE TABLE deployment_resources (
  id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  logical_name TEXT NOT NULL,
  provider_resource_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (deployment_id) REFERENCES deployments(id) ON DELETE CASCADE,
  UNIQUE (deployment_id, resource_type, logical_name)
);
