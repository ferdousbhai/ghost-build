import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { appDeploymentIdFromResourceName, appResourceName } from '~/lib/cloudflare/app-resource-names';
import type { UserCloudflareAccountApi } from '~/lib/.server/cloudflare/user-account-api';

/**
 * Account-anchored reconciliation for Ghostbuild-managed app resources.
 *
 * The registry-driven collector in `app-resource-gc.server` can only reclaim resources it
 * remembers creating: it joins candidates to `chats` and walks that chat's stored deployment
 * plan. Anything provisioned before the registry existed, or whose chat row is gone, is
 * invisible to it forever. This sweep inverts the anchor - it reads the live Cloudflare account
 * and treats the app Worker as the sole proof of liveness, so it needs no registry at all.
 */

/** Resources younger than this are assumed to belong to an in-flight deployment. */
export const APP_RESOURCE_RECONCILE_GRACE_MS = 24 * 60 * 60 * 1000;

/** Deleting a bounded batch per sweep keeps one bad scan from emptying an account. */
const DELETE_LIMIT = 5;

/**
 * What a sweep is allowed to do. `report` nominates and logs; `enforce` also deletes, still
 * bounded by `DELETE_LIMIT`.
 */
type AppResourceReconcileMode = 'report' | 'enforce';

/**
 * Reporting only, until an operator has read a run of real diffs from the logs. Deletion is one
 * reviewed edit away rather than a runtime toggle nobody can audit after the fact.
 */
export const APP_RESOURCE_RECONCILE_MODE: AppResourceReconcileMode = 'report';

const logger = createScopedLogger('CloudflareAppResourceReconcile');

export type OrphanedAppResourceKind = 'd1' | 'kv' | 'r2';

type OrphanedAppResource = {
  kind: OrphanedAppResourceKind;
  /** The provider id the account listing reported. R2 buckets are addressed by their name. */
  id: string;
  name: string;
  deploymentId: string;
};

export type AppResourceReconcileApi = Pick<
  UserCloudflareAccountApi,
  | 'listWorkerNames'
  | 'listD1Databases'
  | 'listKvNamespaces'
  | 'listR2Buckets'
  | 'deleteD1DatabaseById'
  | 'deleteKvNamespaceById'
  | 'deleteR2Bucket'
>;

type AppResourceReconcileReport = {
  scanned: number;
  orphans: OrphanedAppResource[];
  deleted: OrphanedAppResource[];
  /** Resource kinds whose account listing could not be read, so their orphans are under-reported. */
  skippedListings: string[];
};

type DeploymentGroup = {
  resources: OrphanedAppResource[];
  /** Newest creation time across the group's datable resources, or null when none carry one. */
  newestCreatedAt: number | null;
};

/**
 * Find every app resource whose anchoring Worker no longer exists. A deployment is live while
 * `ghostbuild-<id>` is present in the account, regardless of what any registry believes.
 */
export async function findOrphanedAppResources(
  api: AppResourceReconcileApi,
  now: number,
): Promise<{ orphans: OrphanedAppResource[]; scanned: number; undatable: string[]; skippedListings: string[] }> {
  const skippedListings: string[] = [];
  // The Worker listing is the one answer that must be complete, so its failure fails the sweep.
  const [workers, databases, namespaces, buckets] = await Promise.all([
    api.listWorkerNames(),
    listedOrSkipped('D1 database', skippedListings, () => api.listD1Databases()),
    listedOrSkipped('KV namespace', skippedListings, () => api.listKvNamespaces()),
    listedOrSkipped('R2 bucket', skippedListings, () => api.listR2Buckets()),
  ]);

  const liveWorkers = new Set(workers);
  const groups = new Map<string, DeploymentGroup>();

  const candidates: Array<{ kind: OrphanedAppResourceKind; id: string; name: string; createdAt: number | null }> = [
    ...databases.map((database) => ({
      kind: 'd1' as const,
      id: database.id,
      name: database.name,
      createdAt: database.createdAt,
    })),
    // KV namespaces carry no creation time; they are dated by their deployment siblings.
    ...namespaces.map((namespace) => ({
      kind: 'kv' as const,
      id: namespace.id,
      name: namespace.name,
      createdAt: null,
    })),
    // R2 buckets have no id of their own: the name is the address.
    ...buckets.map((bucket) => ({
      kind: 'r2' as const,
      id: bucket.name,
      name: bucket.name,
      createdAt: bucket.createdAt,
    })),
  ];

  for (const { kind, id, name, createdAt } of candidates) {
    const deploymentId = appDeploymentIdFromResourceName(name);
    if (!deploymentId) {
      continue;
    }
    const group = groups.get(deploymentId) ?? { resources: [], newestCreatedAt: null };
    group.resources.push({ kind, id, name, deploymentId });
    if (createdAt !== null) {
      group.newestCreatedAt = group.newestCreatedAt === null ? createdAt : Math.max(group.newestCreatedAt, createdAt);
    }
    groups.set(deploymentId, group);
  }

  const orphans: OrphanedAppResource[] = [];
  const undatable: string[] = [];
  let scanned = 0;

  for (const [deploymentId, group] of groups) {
    scanned += group.resources.length;
    if (liveWorkers.has(appResourceName(deploymentId, 'app'))) {
      continue;
    }
    if (group.newestCreatedAt === null) {
      // Nothing in the group can be dated, so the grace period cannot be honoured. Never guess.
      undatable.push(deploymentId);
      continue;
    }
    if (now - group.newestCreatedAt < APP_RESOURCE_RECONCILE_GRACE_MS) {
      continue;
    }
    orphans.push(...group.resources);
  }

  return { orphans, scanned, undatable, skippedListings };
}

/**
 * Reconcile the account against its live Workers. Reports by default: callers must ask for
 * `enforce` before anything is deleted, so the diff can be observed before it is trusted.
 */
export async function reconcileAppResources(
  api: AppResourceReconcileApi,
  options: { now?: number; mode?: AppResourceReconcileMode } = {},
): Promise<AppResourceReconcileReport> {
  const now = options.now ?? Date.now();
  const mode = options.mode ?? 'report';
  const { orphans, scanned, undatable, skippedListings } = await findOrphanedAppResources(api, now);

  if (undatable.length > 0) {
    logger.warn(`Skipped ${undatable.length} undatable app deployment(s) with no creation time`);
  }
  if (mode === 'report' || orphans.length === 0) {
    if (mode === 'report' && orphans.length > 0) {
      logger.info(`Reconcile report found ${orphans.length} orphaned app resource(s) across ${scanned} scanned`);
    }
    return { scanned, orphans, deleted: [], skippedListings };
  }

  // Databases first, then caches, then buckets: buckets are the slowest and the most restartable.
  const ordered = [
    ...orphans.filter((resource) => resource.kind === 'd1'),
    ...orphans.filter((resource) => resource.kind === 'kv'),
    ...orphans.filter((resource) => resource.kind === 'r2'),
  ].slice(0, DELETE_LIMIT);

  const deleted: OrphanedAppResource[] = [];
  for (const resource of ordered) {
    try {
      if (resource.kind === 'd1') {
        await api.deleteD1DatabaseById(resource.id);
      } else if (resource.kind === 'kv') {
        await api.deleteKvNamespaceById(resource.id);
      } else if (!(await api.deleteR2Bucket(resource.name))) {
        // The bucket still holds objects; a later sweep drains the next batch.
        continue;
      }
      deleted.push(resource);
    } catch {
      logger.warn(`Unable to reconcile orphaned ${resource.kind} resource`);
    }
  }
  if (orphans.length > ordered.length) {
    logger.info(`Reconcile deferred ${orphans.length - ordered.length} orphaned resource(s) past the sweep limit`);
  }
  return { scanned, orphans, deleted, skippedListings };
}

/**
 * A resource listing that cannot be read - a page over the response cap, a provider error -
 * costs its own kind and nothing else. Under-reporting orphans only makes the sweep do less
 * than it should; losing the whole run to one bad listing helps nobody. The skip is named in
 * the report so a run with a hole in it is never mistaken for a clean account.
 */
async function listedOrSkipped<T>(kind: string, skipped: string[], list: () => Promise<T[]>): Promise<T[]> {
  try {
    return await list();
  } catch (error) {
    // The skip is recorded either way; the reason is what tells an operator whether this is a
    // revoked token, a rate limit, or an account too large to page through.
    logger.warn(
      `Skipped the ${kind} listing: the account could not be read`,
      error instanceof Error ? error.message : String(error),
    );
    skipped.push(kind);
    return [];
  }
}
