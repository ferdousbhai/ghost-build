import {
  DEPLOYMENT_SECURITY_BASELINE_BINDING,
  DEPLOYMENT_SECURITY_BOUNDARY_BINDING,
  DEPLOYMENT_SECURITY_CLEANUP_CRON,
  DEPLOYMENT_TEMPLATE_SOURCE_BINDING,
  DEPLOYMENT_VERSION_METADATA_BINDING,
} from './deployment-security-baseline';
import type { Deployment } from './deployment-repository';
import type { ActiveWorkerDeploymentReadback, UserCloudflareAccountApi } from './user-account-api';

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
  requireExpectedAgentSecurityD1Identity?: boolean;
  requiresAgentCleanup: boolean;
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
  const current =
    observedTemplateSourceSha256 === args.expectedTemplateSourceSha256 &&
    observedSecurityBaselineVersion === args.expectedSecurityBaselineVersion &&
    observedSecurityBoundarySha256 === args.expectedSecurityBoundarySha256 &&
    hasVersionMetadata &&
    hasCleanup &&
    hasAgentSecurityDb &&
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
  attempts?: number;
  retryDelay?: (milliseconds: number) => Promise<void>;
}): Promise<DeploymentSecurityAttestation> {
  const requiresAgentSecurityDb = args.deployment.plan.project?.bindings.appAgent ?? true;
  if (requiresAgentSecurityDb && !args.expectedAgentSecurityD1DatabaseId) {
    throw new DeploymentSecurityAttestationError(
      'Published AppAgent Worker is missing its provisioned agent security D1 identity.',
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
        requireExpectedAgentSecurityD1Identity: requiresAgentSecurityDb,
        requiresAgentCleanup: requiresAgentSecurityDb,
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
