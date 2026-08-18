import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { createUserAccountApi } from '~/lib/.server/cloudflare/user-workspace-deployment-executor';
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

const RESOURCE_PREFIX = 'ghostbuild-';

/**
 * Only canonical UUID deployment ids are eligible. This is the safety gate that keeps the sweep
 * away from resources that share the prefix but have a different lifecycle - workspace runtimes
 * (`ghostbuild-workspace-<hex16>`), their databases (`ghostbuild-data-<hex16>`), the shared
 * `ghostbuild-builder-skills` bucket, and the control plane itself.
 */
const APP_DEPLOYMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const APP_RESOURCE_SUFFIX = /-(agent-security|storage|cache)$/;

const logger = createScopedLogger('CloudflareAppResourceReconcile');

type OrphanedAppResourceKind = 'd1' | 'kv' | 'r2';

type OrphanedAppResource = {
  kind: OrphanedAppResourceKind;
  name: string;
  deploymentId: string;
};

export type AppResourceReconcileApi = Pick<
  UserCloudflareAccountApi,
  | 'listWorkerNames'
  | 'listD1Databases'
  | 'listKvNamespaces'
  | 'listR2Buckets'
  | 'deleteD1Database'
  | 'deleteKvNamespace'
  | 'deleteR2Bucket'
>;

type AppResourceReconcileReport = {
  scanned: number;
  orphans: OrphanedAppResource[];
  deleted: OrphanedAppResource[];
};

/**
 * Recover the app deployment id a resource belongs to, or null when the name is not an app
 * resource. Returning null is always the safe answer - an unrecognised name is never collected.
 */
export function appDeploymentIdFromResourceName(name: string): string | null {
  if (!name.startsWith(RESOURCE_PREFIX)) {
    return null;
  }
  const candidate = name.slice(RESOURCE_PREFIX.length).replace(APP_RESOURCE_SUFFIX, '');
  return APP_DEPLOYMENT_ID.test(candidate) ? candidate : null;
}

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
): Promise<{ orphans: OrphanedAppResource[]; scanned: number; undatable: string[] }> {
  const [workerNames, databases, namespaces, buckets] = await Promise.all([
    api.listWorkerNames(),
    api.listD1Databases(),
    api.listKvNamespaces(),
    api.listR2Buckets(),
  ]);

  const liveWorkers = new Set(workerNames);
  const groups = new Map<string, DeploymentGroup>();

  const candidates: Array<{ kind: OrphanedAppResourceKind; name: string; createdAt: number | null }> = [
    ...databases.map((database) => ({ kind: 'd1' as const, name: database.name, createdAt: database.createdAt })),
    // KV namespaces carry no creation time; they are dated by their deployment siblings.
    ...namespaces.map((namespace) => ({ kind: 'kv' as const, name: namespace.name, createdAt: null })),
    ...buckets.map((bucket) => ({ kind: 'r2' as const, name: bucket.name, createdAt: bucket.createdAt })),
  ];

  for (const { kind, name, createdAt } of candidates) {
    const deploymentId = appDeploymentIdFromResourceName(name);
    if (!deploymentId) {
      continue;
    }
    const group = groups.get(deploymentId) ?? { resources: [], newestCreatedAt: null };
    group.resources.push({ kind, name, deploymentId });
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
    if (liveWorkers.has(`${RESOURCE_PREFIX}${deploymentId}`)) {
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

  return { orphans, scanned, undatable };
}

/**
 * Reconcile the account against its live Workers. Defaults to a dry run: callers must opt in
 * before anything is deleted, so the diff can be observed before it is trusted.
 */
export async function reconcileAppResources(
  api: AppResourceReconcileApi,
  options: { now?: number; dryRun?: boolean } = {},
): Promise<AppResourceReconcileReport> {
  const now = options.now ?? Date.now();
  const dryRun = options.dryRun ?? true;
  const { orphans, scanned, undatable } = await findOrphanedAppResources(api, now);

  if (undatable.length > 0) {
    logger.warn(`Skipped ${undatable.length} undatable app deployment(s) with no creation time`);
  }
  if (dryRun || orphans.length === 0) {
    if (dryRun && orphans.length > 0) {
      logger.info(`Reconcile dry run found ${orphans.length} orphaned app resource(s) across ${scanned} scanned`);
    }
    return { scanned, orphans, deleted: [] };
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
        await api.deleteD1Database(resource.name);
      } else if (resource.kind === 'kv') {
        await api.deleteKvNamespace(resource.name);
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
  return { scanned, orphans, deleted };
}

type ReconcileEnv = Parameters<typeof createUserAccountApi>[0] & {
  /** Set to 'enforce' to allow deletion. Anything else - including unset - stays a dry run. */
  GHOSTBUILD_RECONCILE_MODE?: string;
};

/**
 * Run reconciliation on the maintenance cron without ever failing it. Deletion stays opt-in via
 * GHOSTBUILD_RECONCILE_MODE so the diff can be watched in logs before it is trusted to act.
 */
export async function reconcileAppResourcesBestEffort(env: ReconcileEnv): Promise<void> {
  try {
    const api = await createUserAccountApi(env, fetch);
    const report = await reconcileAppResources(api, { dryRun: env.GHOSTBUILD_RECONCILE_MODE !== 'enforce' });
    if (report.orphans.length > 0) {
      logger.info(
        `Reconciled ${report.deleted.length}/${report.orphans.length} orphaned app resource(s) across ${report.scanned} scanned`,
      );
    }
  } catch {
    logger.warn('Unable to reconcile orphaned app Cloudflare resources');
  }
}
