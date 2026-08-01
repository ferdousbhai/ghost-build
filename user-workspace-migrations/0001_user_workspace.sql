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

CREATE TABLE cloudflare_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL,
  account_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('linking', 'active', 'revoked', 'error')),
  credential_handle TEXT,
  granted_scopes_json TEXT NOT NULL DEFAULT '[]',
  ai_billing_enabled INTEGER NOT NULL DEFAULT 0 CHECK (ai_billing_enabled IN (0, 1)),
  connected_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  connection_generation INTEGER NOT NULL DEFAULT 1 CHECK (connection_generation > 0)
);

CREATE TABLE deployments (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  connection_generation INTEGER NOT NULL,
  execution_generation INTEGER NOT NULL DEFAULT 0 CHECK (execution_generation >= 0),
  build_artifact_key TEXT,
  build_artifact_generation INTEGER CHECK (build_artifact_generation IS NULL OR build_artifact_generation >= 1),
  snapshot_key TEXT,
  status TEXT NOT NULL CHECK (
    status IN (
      'planned', 'awaiting_approval', 'approved', 'provisioning', 'building',
      'deploying', 'succeeded', 'failed', 'canceled'
    )
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
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
  FOREIGN KEY (connection_id) REFERENCES cloudflare_connections(id)
);

CREATE INDEX idx_deployments_user_created
ON deployments(user_id, created_at DESC);
CREATE INDEX idx_deployments_chat_created
ON deployments(chat_id, created_at DESC);
CREATE INDEX idx_deployments_status_updated
ON deployments(status, updated_at);

CREATE TRIGGER trg_deployments_approval_generation
AFTER UPDATE OF status ON deployments
WHEN OLD.status = 'awaiting_approval'
  AND NEW.status = 'approved'
  AND NEW.execution_generation = OLD.execution_generation
BEGIN
  UPDATE deployments
  SET execution_generation = OLD.execution_generation + 1
  WHERE id = NEW.id
    AND status = 'approved'
    AND execution_generation = OLD.execution_generation;
END;

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

CREATE TABLE deployment_security_inventory (
  connection_id TEXT NOT NULL,
  worker_name TEXT NOT NULL,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  managed_deployment_id TEXT,
  requires_agent_cleanup INTEGER NOT NULL CHECK (requires_agent_cleanup IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('current', 'legacy_candidate', 'drifted', 'unreachable', 'not_found')),
  expected_template_source_sha256 TEXT CHECK (
    expected_template_source_sha256 IS NULL OR length(expected_template_source_sha256) = 64
  ),
  expected_security_baseline_version INTEGER CHECK (
    expected_security_baseline_version IS NULL OR expected_security_baseline_version > 0
  ),
  expected_security_boundary_sha256 TEXT CHECK (
    expected_security_boundary_sha256 IS NULL OR length(expected_security_boundary_sha256) = 64
  ),
  observed_template_source_sha256 TEXT CHECK (
    observed_template_source_sha256 IS NULL OR length(observed_template_source_sha256) = 64
  ),
  observed_security_baseline_version INTEGER CHECK (
    observed_security_baseline_version IS NULL OR observed_security_baseline_version > 0
  ),
  observed_security_boundary_sha256 TEXT CHECK (
    observed_security_boundary_sha256 IS NULL OR length(observed_security_boundary_sha256) = 64
  ),
  provider_deployment_id TEXT,
  attested_worker_version_id TEXT,
  attested_script_etag TEXT CHECK (
    attested_script_etag IS NULL OR length(attested_script_etag) BETWEEN 1 AND 256
  ),
  worker_version_id TEXT,
  script_etag TEXT CHECK (script_etag IS NULL OR length(script_etag) BETWEEN 1 AND 256),
  last_error TEXT,
  attested_at INTEGER,
  last_checked_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (connection_id, worker_name),
  FOREIGN KEY (connection_id) REFERENCES cloudflare_connections(id) ON DELETE CASCADE,
  FOREIGN KEY (managed_deployment_id) REFERENCES deployments(id) ON DELETE SET NULL
);

CREATE INDEX idx_deployment_inventory_status
ON deployment_security_inventory(status, last_checked_at);

CREATE TABLE object_gc_candidates (
  storage_key TEXT PRIMARY KEY,
  not_before INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0)
);
