import { BUILDER_TEMPLATE_SOURCE_SHA256 } from '~/agents/builder-template.generated';

export const DEPLOYMENT_SECURITY_BASELINE_VERSION = 38 as const;
export {
  DEPLOYMENT_SECURITY_BASELINE_BINDING,
  DEPLOYMENT_SECURITY_BOUNDARY_BINDING,
  DEPLOYMENT_SECURITY_CLEANUP_CRON,
  DEPLOYMENT_PREVIEW_URLS_ENABLED,
  DEPLOYMENT_TEMPLATE_SOURCE_BINDING,
  DEPLOYMENT_VERSION_METADATA_BINDING,
} from './deployment-runtime-policy';

export const TEMPLATE_SOURCE_SHA256 = BUILDER_TEMPLATE_SOURCE_SHA256;

/**
 * The generated AppAgent's authentication, inference-budget, retention, and request-routing
 * boundary, as one pinned digest. It is injected into every managed deployment as the
 * `GHOSTBUILD_SECURITY_BOUNDARY_SHA256` binding and the readback attestation checks it round-trips,
 * so a deployment fails closed unless it carries exactly this boundary.
 */
export const APP_AGENT_SECURITY_BOUNDARY_SHA256 = 'baf154355ecd22415600b5b1c96b3dca2e58d40739f8cdf020414d9c4ea508ad';

export function isCurrentDeploymentSecurityIdentity(value: {
  version?: unknown;
  templateSourceSha256?: unknown;
  securityBaselineVersion?: unknown;
  securityBoundarySha256?: unknown;
}): boolean {
  return (
    value.version === 5 &&
    value.templateSourceSha256 === TEMPLATE_SOURCE_SHA256 &&
    value.securityBaselineVersion === DEPLOYMENT_SECURITY_BASELINE_VERSION &&
    value.securityBoundarySha256 === APP_AGENT_SECURITY_BOUNDARY_SHA256
  );
}
