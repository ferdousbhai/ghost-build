-- What provisioning created in a user's own Cloudflare account, recorded before it exists.
--
-- Provisioning creates a D1 database, a Worker, and a container application before it can know
-- whether the attempt will finish. The control plane has always recorded the Worker, in
-- `user_computer_runtimes.worker_name`, and never the database: an attempt that failed and was
-- never retried left behind a `ghostbuild-data-<hex16>` nothing here could name, let alone delete.
--
-- The account-anchored sweep cannot close that gap. It recognises app resources by name shape,
-- and the single rule that keeps it away from live workspace databases is that it admits no name
-- that is not `ghostbuild-<uuid>`. Reclaiming workspace resources therefore has to be anchored on
-- a record of what was provisioned - this table - and never on a prefix match.
--
-- Rows survive reclamation and survive the resource names ceasing to be derivable: a record of
-- what Ghostbuild created in someone else's account is the whole point of keeping it.
CREATE TABLE user_workspace_runtime_resources (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('worker', 'd1', 'container')),
  resource_name TEXT NOT NULL,
  -- Null until the provider id is known, and permanently null for resources the provider
  -- addresses by name. The name is always recorded, so a row is reclaimable either way.
  provider_resource_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  reclaimed_at INTEGER,
  PRIMARY KEY (user_id, account_id, resource_type, resource_name)
);

CREATE INDEX idx_user_workspace_runtime_resources_outstanding
ON user_workspace_runtime_resources(user_id, account_id) WHERE reclaimed_at IS NULL;
