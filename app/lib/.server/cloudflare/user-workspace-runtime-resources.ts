/**
 * The record of what workspace provisioning created in a user's own Cloudflare account.
 *
 * `user_computer_runtimes` records where a workspace runtime *is*; this records what it *made*.
 * The distinction only matters once an attempt stops halfway: the runtime row names the Worker
 * and nothing else, so an abandoned attempt used to leave a D1 database that no query here could
 * name. Recording each resource under the name provisioning will use, before the call that
 * creates it, is what makes an attempt that dies mid-flight reclaimable at all.
 *
 * This is the workspace counterpart of `deployment_resources`, and it exists for the same reason:
 * reclamation that re-derives names is only as good as the derivation, and the one derivation
 * available here - the `ghostbuild-<hex16>` name shape - is deliberately not trusted, because a
 * prefix match over it would also match every live workspace database.
 */

export type UserWorkspaceRuntimeResourceType = 'worker' | 'd1' | 'container';

export type UserWorkspaceRuntimeResource = {
  resourceType: UserWorkspaceRuntimeResourceType;
  resourceName: string;
  /** Null while the provider id is unknown, and for resources the provider addresses by name. */
  providerResourceId: string | null;
};

/** A resource being recorded. The id is optional because it is often not known yet. */
type RecordedWorkspaceRuntimeResource = {
  resourceType: UserWorkspaceRuntimeResourceType;
  resourceName: string;
  providerResourceId?: string;
};

type UserWorkspaceRuntimeResourceRow = {
  resource_type: UserWorkspaceRuntimeResourceType;
  resource_name: string;
  provider_resource_id: string | null;
};

/**
 * Record resources against one account, or update what is known about them.
 *
 * A provider id is only ever added, never cleared: the second call of a provisioning attempt
 * fills in what the first could not know, and a retry that finds the resource already there
 * re-states the same id. `reclaimed_at` is cleared because a name recorded again is a resource
 * that exists again.
 */
export async function recordUserWorkspaceRuntimeResources(args: {
  db: D1Database;
  userId: string;
  accountId: string;
  resources: readonly RecordedWorkspaceRuntimeResource[];
  now?: number;
}): Promise<void> {
  if (args.resources.length === 0) {
    return;
  }
  const now = args.now ?? Date.now();
  await args.db.batch(
    args.resources.map((resource) =>
      args.db
        .prepare(
          `INSERT INTO user_workspace_runtime_resources (
             user_id, account_id, resource_type, resource_name, provider_resource_id, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, account_id, resource_type, resource_name) DO UPDATE SET
             provider_resource_id = COALESCE(excluded.provider_resource_id, user_workspace_runtime_resources.provider_resource_id),
             reclaimed_at = NULL,
             updated_at = excluded.updated_at`,
        )
        .bind(
          args.userId,
          args.accountId,
          resource.resourceType,
          resource.resourceName,
          resource.providerResourceId ?? null,
          now,
          now,
        ),
    ),
  );
}

/** Everything recorded for one account that has not been reclaimed yet. */
export async function listOutstandingUserWorkspaceRuntimeResources(
  db: D1Database,
  userId: string,
  accountId: string,
): Promise<UserWorkspaceRuntimeResource[]> {
  const result = await db
    .prepare(
      `SELECT resource_type, resource_name, provider_resource_id
       FROM user_workspace_runtime_resources
       WHERE user_id = ? AND account_id = ? AND reclaimed_at IS NULL
       ORDER BY resource_type, resource_name`,
    )
    .bind(userId, accountId)
    .all<UserWorkspaceRuntimeResourceRow>();
  return result.results.map((row) => ({
    resourceType: row.resource_type,
    resourceName: row.resource_name,
    providerResourceId: row.provider_resource_id,
  }));
}

/**
 * Record that named resources are gone. Rows stay: an operator asking what Ghostbuild ever put in
 * an account gets the same answer before and after reclamation, with a date attached.
 */
export async function markUserWorkspaceRuntimeResourcesReclaimed(args: {
  db: D1Database;
  userId: string;
  accountId: string;
  resources: readonly Pick<UserWorkspaceRuntimeResource, 'resourceType' | 'resourceName'>[];
  now?: number;
}): Promise<void> {
  if (args.resources.length === 0) {
    return;
  }
  const now = args.now ?? Date.now();
  await args.db.batch(
    args.resources.map((resource) =>
      args.db
        .prepare(
          `UPDATE user_workspace_runtime_resources
           SET reclaimed_at = ?, updated_at = ?
           WHERE user_id = ? AND account_id = ? AND resource_type = ? AND resource_name = ?
             AND reclaimed_at IS NULL`,
        )
        .bind(now, now, args.userId, args.accountId, resource.resourceType, resource.resourceName),
    ),
  );
}
