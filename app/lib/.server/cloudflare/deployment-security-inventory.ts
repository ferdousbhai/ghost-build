import {
  DEPLOYMENT_SECURITY_BASELINE_BINDING,
  DEPLOYMENT_SECURITY_BOUNDARY_BINDING,
  DEPLOYMENT_SECURITY_CLEANUP_CRON,
  DEPLOYMENT_PREVIEW_URLS_ENABLED,
  DEPLOYMENT_TEMPLATE_SOURCE_BINDING,
  DEPLOYMENT_VERSION_METADATA_BINDING,
} from './deployment-security-baseline';
import type { Deployment } from './deployment-repository';
import type { ActiveWorkerDeploymentReadback, UserCloudflareAccountApi } from './user-account-api';
import { deploymentProjectProfile } from './deployment-plan';
import { DEPLOYMENT_COMPATIBILITY_DATE, DEPLOYMENT_COMPATIBILITY_FLAGS } from './deployment-runtime-policy';

const MANAGED_ATTESTATION_ATTEMPTS = 6;
const MANAGED_ATTESTATION_RETRY_MS = 1_000;

type DeploymentSecurityAttestation = {
  status: 'current' | 'drifted';
  expectedTemplateSourceSha256: string;
  expectedSecurityBaselineVersion: number;
  expectedSecurityBoundarySha256: string;
  observedTemplateSourceSha256: string | null;
  observedSecurityBaselineVersion: number | null;
  observedSecurityBoundarySha256: string | null;
  providerDeploymentId: string;
  workerVersionId: string;
  scriptEtag: string;
};

export function evaluateDeploymentSecurityAttestation(args: {
  readback: ActiveWorkerDeploymentReadback;
  expectedWorkerVersionId?: string;
  expectedScriptEtag?: string;
  expectedTemplateSourceSha256: string;
  expectedSecurityBaselineVersion: number;
  expectedSecurityBoundarySha256: string;
  expectedAgentSecurityD1DatabaseId?: string;
  expectedKvNamespaceId?: string;
  requireExpectedAgentSecurityD1Identity?: boolean;
  requiresAgentCleanup: boolean;
  expectedBindings?: ReadonlyArray<{ name: string; type: string }>;
  expectedCompatibilityDate?: string;
  expectedCompatibilityFlags?: readonly string[];
}): DeploymentSecurityAttestation {
  const observedTemplateSourceSha256 = plainTextBinding(args.readback, DEPLOYMENT_TEMPLATE_SOURCE_BINDING);
  const rawBaseline = plainTextBinding(args.readback, DEPLOYMENT_SECURITY_BASELINE_BINDING);
  const observedSecurityBoundarySha256 = plainTextBinding(args.readback, DEPLOYMENT_SECURITY_BOUNDARY_BINDING);
  const observedSecurityBaselineVersion = /^(?:0|[1-9][0-9]*)$/.test(rawBaseline ?? '') ? Number(rawBaseline) : null;
  const hasVersionMetadata = args.readback.bindings.some(
    (binding) => binding.name === DEPLOYMENT_VERSION_METADATA_BINDING && binding.type === 'version_metadata',
  );
  const hasCleanup =
    !args.requiresAgentCleanup ||
    (args.readback.crons.length === 1 && args.readback.crons[0] === DEPLOYMENT_SECURITY_CLEANUP_CRON);
  const agentSecurityBindings = args.readback.bindings.filter((binding) => binding.name === 'AGENT_SECURITY_DB');
  const agentSecurityBinding = agentSecurityBindings[0];
  const hasAgentSecurityDb =
    !args.requiresAgentCleanup ||
    ((!args.requireExpectedAgentSecurityD1Identity || args.expectedAgentSecurityD1DatabaseId !== undefined) &&
      agentSecurityBindings.length === 1 &&
      agentSecurityBinding?.type === 'd1' &&
      typeof agentSecurityBinding.database_id === 'string' &&
      agentSecurityBinding.database_id.length > 0 &&
      (args.expectedAgentSecurityD1DatabaseId === undefined ||
        agentSecurityBinding.database_id === args.expectedAgentSecurityD1DatabaseId));
  const kvBindings = args.readback.bindings.filter((binding) => binding.name === 'APP_CACHE');
  const hasExpectedKvNamespace =
    args.expectedKvNamespaceId === undefined ||
    (kvBindings.length === 1 &&
      kvBindings[0]?.type === 'kv_namespace' &&
      kvBindings[0].namespace_id === args.expectedKvNamespaceId);
  // Preview URLs are a deliberate part of the managed publication boundary: every unpromoted
  // version is public on its versioned workers.dev hostname, while the production hostname stays
  // enabled for the version that is promoted.
  const hasManagedWorkerSubdomain =
    args.readback.workersDevEnabled && args.readback.previewUrlsEnabled === DEPLOYMENT_PREVIEW_URLS_ENABLED;
  const current =
    observedTemplateSourceSha256 === args.expectedTemplateSourceSha256 &&
    observedSecurityBaselineVersion === args.expectedSecurityBaselineVersion &&
    observedSecurityBoundarySha256 === args.expectedSecurityBoundarySha256 &&
    hasVersionMetadata &&
    hasCleanup &&
    hasAgentSecurityDb &&
    hasExpectedKvNamespace &&
    hasManagedWorkerSubdomain &&
    (!args.expectedBindings || exactBindingInventory(args.readback.bindings, args.expectedBindings)) &&
    (args.expectedCompatibilityDate === undefined ||
      args.readback.compatibilityDate === args.expectedCompatibilityDate) &&
    (args.expectedCompatibilityFlags === undefined ||
      exactStrings(args.readback.compatibilityFlags, args.expectedCompatibilityFlags)) &&
    (args.expectedWorkerVersionId === undefined || args.readback.workerVersionId === args.expectedWorkerVersionId) &&
    (args.expectedScriptEtag === undefined || args.readback.scriptEtag === args.expectedScriptEtag);
  return {
    status: current ? 'current' : 'drifted',
    expectedTemplateSourceSha256: args.expectedTemplateSourceSha256,
    expectedSecurityBaselineVersion: args.expectedSecurityBaselineVersion,
    expectedSecurityBoundarySha256: args.expectedSecurityBoundarySha256,
    observedTemplateSourceSha256,
    observedSecurityBaselineVersion,
    observedSecurityBoundarySha256,
    providerDeploymentId: args.readback.providerDeploymentId,
    workerVersionId: args.readback.workerVersionId,
    scriptEtag: args.readback.scriptEtag,
  };
}

/** Read back the exact published Worker before a deployment may succeed. */
export async function attestManagedDeploymentSecurity(args: {
  deployment: Deployment;
  workerName: string;
  accountApi: Pick<UserCloudflareAccountApi, 'readActiveWorkerDeployment'>;
  expectedPublishedVersionId: string;
  expectedAgentSecurityD1DatabaseId?: string;
  expectedKvNamespaceId?: string;
  attempts?: number;
  retryDelay?: (milliseconds: number) => Promise<void>;
}): Promise<DeploymentSecurityAttestation> {
  const requiresAgentSecurityDb = args.deployment.plan.project.bindings.appAgent;
  const profile = deploymentProjectProfile(args.deployment.plan);
  if (requiresAgentSecurityDb && !args.expectedAgentSecurityD1DatabaseId) {
    throw new DeploymentSecurityAttestationError(
      'Published AppAgent Worker is missing its provisioned agent security D1 identity.',
    );
  }
  if (profile.bindings.kv && !args.expectedKvNamespaceId) {
    throw new DeploymentSecurityAttestationError(
      'Published Worker with APP_CACHE is missing its provisioned KV namespace identity.',
    );
  }
  const attempts = args.attempts ?? MANAGED_ATTESTATION_ATTEMPTS;
  const retryDelay =
    args.retryDelay ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let lastAttestation: DeploymentSecurityAttestation | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const readback = await args.accountApi.readActiveWorkerDeployment(args.workerName);
    if (readback) {
      lastAttestation = evaluateDeploymentSecurityAttestation({
        readback,
        expectedTemplateSourceSha256: args.deployment.plan.templateSourceSha256,
        expectedSecurityBaselineVersion: args.deployment.plan.securityBaselineVersion,
        expectedSecurityBoundarySha256: args.deployment.plan.securityBoundarySha256,
        expectedWorkerVersionId: args.expectedPublishedVersionId,
        expectedAgentSecurityD1DatabaseId: args.expectedAgentSecurityD1DatabaseId,
        expectedKvNamespaceId: args.expectedKvNamespaceId,
        requireExpectedAgentSecurityD1Identity: requiresAgentSecurityDb,
        requiresAgentCleanup: requiresAgentSecurityDb,
        expectedBindings: expectedManagedBindings(profile.bindings),
        expectedCompatibilityDate: DEPLOYMENT_COMPATIBILITY_DATE,
        expectedCompatibilityFlags: DEPLOYMENT_COMPATIBILITY_FLAGS,
      });
      if (lastAttestation.status === 'current') {
        return lastAttestation;
      }
    }
    if (attempt < attempts) {
      await retryDelay(MANAGED_ATTESTATION_RETRY_MS);
    }
  }
  if (!lastAttestation) {
    throw new DeploymentSecurityAttestationError('Published Worker is unavailable for security attestation.');
  }
  throw new DeploymentSecurityAttestationError('Published Worker security metadata did not match its approved plan.');
}

function expectedManagedBindings(bindings: {
  ai: boolean;
  d1: boolean;
  r2: boolean;
  kv: boolean;
  appAgent: boolean;
}): Array<{ name: string; type: string }> {
  return [
    { name: DEPLOYMENT_VERSION_METADATA_BINDING, type: 'version_metadata' },
    { name: DEPLOYMENT_SECURITY_BASELINE_BINDING, type: 'plain_text' },
    { name: DEPLOYMENT_SECURITY_BOUNDARY_BINDING, type: 'plain_text' },
    { name: DEPLOYMENT_TEMPLATE_SOURCE_BINDING, type: 'plain_text' },
    ...(bindings.ai ? [{ name: 'AI', type: 'ai' }] : []),
    ...(bindings.d1 ? [{ name: 'DB', type: 'd1' }] : []),
    ...(bindings.appAgent ? [{ name: 'AGENT_SECURITY_DB', type: 'd1' }] : []),
    ...(bindings.r2 ? [{ name: 'APP_STORAGE', type: 'r2_bucket' }] : []),
    ...(bindings.kv ? [{ name: 'APP_CACHE', type: 'kv_namespace' }] : []),
    ...(bindings.appAgent ? [{ name: 'AppAgent', type: 'durable_object_namespace' }] : []),
  ];
}

function exactBindingInventory(
  observed: ReadonlyArray<{ name?: string; type?: string }>,
  expected: ReadonlyArray<{ name: string; type: string }>,
): boolean {
  return exactStrings(
    observed.map((binding) => `${binding.name ?? ''}:${binding.type ?? ''}`),
    expected.map((binding) => `${binding.name}:${binding.type}`),
  );
}

function exactStrings(observed: readonly string[], expected: readonly string[]): boolean {
  if (observed.length !== expected.length) {
    return false;
  }
  const expectedSorted = [...expected].sort();
  return [...observed].sort().every((value, index) => value === expectedSorted[index]);
}

function plainTextBinding(readback: ActiveWorkerDeploymentReadback, name: string): string | null {
  const matches = readback.bindings.filter((binding) => binding.name === name && binding.type === 'plain_text');
  return matches.length === 1 && typeof matches[0]?.text === 'string' ? matches[0].text : null;
}

export class DeploymentSecurityAttestationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeploymentSecurityAttestationError';
  }
}
