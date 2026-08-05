export const DEPLOYMENT_COMPATIBILITY_DATE = '2026-07-21';
export const DEPLOYMENT_COMPATIBILITY_FLAGS = ['nodejs_compat'] as const;
export const DEPLOYMENT_OBSERVABILITY = {
  enabled: true,
  logs: { enabled: true, head_sampling_rate: 0.6 },
  traces: { enabled: true, head_sampling_rate: 0.05 },
} as const;
export const APP_AGENT_DECLARATIVE_EXPORT = {
  type: 'durable-object',
  storage: 'sqlite',
} as const;

/**
 * Canonical managed-Worker deployment contract. Both the user-owned publisher
 * and the control-plane readback attestor import these values so a binding or
 * schedule change cannot be accepted on only one side of the boundary.
 */
export const DEPLOYMENT_PROJECT_ROOT = '/home/project';
export const DEPLOYMENT_WRANGLER_CONFIG_PATH = '/home/.ghostbuild-deploy.json';
export const DEPLOYMENT_VERSION_METADATA_BINDING = 'CF_VERSION_METADATA';
export const DEPLOYMENT_SECURITY_BASELINE_BINDING = 'GHOSTBUILD_SECURITY_BASELINE_VERSION';
export const DEPLOYMENT_TEMPLATE_SOURCE_BINDING = 'GHOSTBUILD_TEMPLATE_SOURCE_SHA256';
export const DEPLOYMENT_SECURITY_BOUNDARY_BINDING = 'GHOSTBUILD_SECURITY_BOUNDARY_SHA256';
export const DEPLOYMENT_SECURITY_CLEANUP_CRON = '0 3 * * *';
