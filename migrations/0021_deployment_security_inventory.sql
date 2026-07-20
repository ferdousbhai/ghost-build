CREATE TABLE IF NOT EXISTS deployment_security_inventory (
  connection_id TEXT NOT NULL REFERENCES cloudflare_connections(id) ON DELETE CASCADE,
  worker_name TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  managed_deployment_id TEXT REFERENCES deployments(id) ON DELETE SET NULL,
  requires_agent_cleanup INTEGER NOT NULL CHECK (requires_agent_cleanup IN (0, 1)),
  status TEXT NOT NULL CHECK (
    status IN ('current', 'legacy_candidate', 'drifted', 'unreachable', 'not_found')
  ),
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
  PRIMARY KEY (connection_id, worker_name)
);

CREATE INDEX IF NOT EXISTS idx_deployment_security_inventory_status_checked
ON deployment_security_inventory(status, last_checked_at);

CREATE INDEX IF NOT EXISTS idx_deployment_security_inventory_user
ON deployment_security_inventory(user_id, updated_at DESC);

-- Seed every managed Worker that was recorded after a publish, including a
-- publish whose later bookkeeping failed. Its immutable provider version and
-- script identity will be established only by a future approved publish, so
-- the inventory must not trust self-asserted Worker variables.
INSERT OR IGNORE INTO deployment_security_inventory (
  connection_id,
  worker_name,
  user_id,
  account_id,
  managed_deployment_id,
  requires_agent_cleanup,
  status,
  last_checked_at,
  created_at,
  updated_at
)
SELECT
  deployment.connection_id,
  resource.provider_resource_id,
  deployment.user_id,
  connection.account_id,
  deployment.id,
  1,
  'legacy_candidate',
  0,
  deployment.updated_at,
  deployment.updated_at
FROM deployments AS deployment
JOIN deployment_resources AS resource ON resource.deployment_id = deployment.id
JOIN cloudflare_connections AS connection ON connection.id = deployment.connection_id
WHERE resource.resource_type = 'worker'
  AND resource.logical_name = 'app'
  AND NOT EXISTS (
    SELECT 1
    FROM deployments AS newer_deployment
    JOIN deployment_resources AS newer_resource
      ON newer_resource.deployment_id = newer_deployment.id
    WHERE newer_deployment.connection_id = deployment.connection_id
      AND newer_resource.resource_type = 'worker'
      AND newer_resource.logical_name = 'app'
      AND newer_resource.provider_resource_id = resource.provider_resource_id
      AND (
        newer_deployment.updated_at > deployment.updated_at
        OR (
          newer_deployment.updated_at = deployment.updated_at
          AND newer_deployment.id > deployment.id
        )
      )
  );

-- Queue one bounded read-only discovery target for the historical fixed Worker
-- name. last_checked_at = 0 is the pending sentinel until scheduled inventory
-- records the provider result.
INSERT OR IGNORE INTO deployment_security_inventory (
  connection_id,
  worker_name,
  user_id,
  account_id,
  managed_deployment_id,
  requires_agent_cleanup,
  status,
  last_checked_at,
  created_at,
  updated_at
)
SELECT
  id,
  'ghostbuild-cloudflare-app',
  user_id,
  account_id,
  NULL,
  1,
  'legacy_candidate',
  0,
  0,
  0
FROM cloudflare_connections
WHERE status = 'active';
