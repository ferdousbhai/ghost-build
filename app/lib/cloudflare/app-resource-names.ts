/**
 * The one naming scheme for Ghostbuild-managed app resources.
 *
 * Deployment planning composes these names; account-anchored reconciliation takes them apart
 * again with no registry to consult. Both directions live here so that adding a binding is a
 * typing error rather than a resource the sweep quietly stops recognising.
 *
 * This module is deliberately dependency-free: reconciliation runs where the deployment planner
 * and its schemas are not welcome, so it must be importable without dragging them along.
 */

const APP_RESOURCE_PREFIX = 'ghostbuild-';

/**
 * Suffix per logical binding name. The Worker anchors the deployment and carries no suffix, and
 * neither does the application database - they are distinguished by resource type, not by name.
 */
const APP_RESOURCE_SUFFIXES = {
  app: '',
  DB: '',
  DB_PREVIEW: '-preview',
  AGENT_SECURITY_DB: '-agent-security',
  AGENT_SECURITY_DB_PREVIEW: '-preview-agent',
  APP_STORAGE: '-storage',
  APP_CACHE: '-cache',
} as const;

type AppResourceLogicalName = keyof typeof APP_RESOURCE_SUFFIXES;

/** Longest first, so a suffix that ends with another still strips whole. */
const APP_RESOURCE_SUFFIX_VALUES = [...new Set(Object.values(APP_RESOURCE_SUFFIXES))]
  .filter((suffix) => suffix.length > 0)
  .sort((left, right) => right.length - left.length);

/**
 * Only canonical UUID deployment ids are eligible. This is the safety gate that keeps the sweep
 * away from resources that share the prefix but have a different lifecycle - workspace runtimes
 * (`ghostbuild-workspace-<hex16>`), their databases (`ghostbuild-data-<hex16>`), the shared
 * `ghostbuild-builder-skills` bucket, and the control plane itself.
 */
const APP_DEPLOYMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function appResourceName(deploymentId: string, logicalName: AppResourceLogicalName): string {
  return `${APP_RESOURCE_PREFIX}${deploymentId}${APP_RESOURCE_SUFFIXES[logicalName]}`;
}

/**
 * Recover the app deployment id a resource belongs to, or null when the name is not an app
 * resource. Returning null is always the safe answer - an unrecognised name is never collected.
 */
export function appDeploymentIdFromResourceName(name: string): string | null {
  if (!name.startsWith(APP_RESOURCE_PREFIX)) {
    return null;
  }
  const remainder = name.slice(APP_RESOURCE_PREFIX.length);
  const suffix = APP_RESOURCE_SUFFIX_VALUES.find((value) => remainder.endsWith(value)) ?? '';
  const candidate = remainder.slice(0, remainder.length - suffix.length);
  return APP_DEPLOYMENT_ID.test(candidate) ? candidate : null;
}
