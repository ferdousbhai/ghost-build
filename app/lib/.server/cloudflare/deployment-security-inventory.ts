import {
  APP_AGENT_SECURITY_BOUNDARY_SHA256,
  DEPLOYMENT_SECURITY_BASELINE_BINDING,
  DEPLOYMENT_SECURITY_BASELINE_VERSION,
  DEPLOYMENT_SECURITY_BOUNDARY_BINDING,
  DEPLOYMENT_SECURITY_CLEANUP_CRON,
  DEPLOYMENT_TEMPLATE_SOURCE_BINDING,
  DEPLOYMENT_VERSION_METADATA_BINDING,
  TEMPLATE_SOURCE_SHA256,
} from './deployment-security-baseline';
import type { Deployment } from './deployment-repository';
import {
  CloudflareAccountApiError,
  UserCloudflareAccountApi,
  type ActiveWorkerDeploymentReadback,
} from './user-account-api';

const HISTORICAL_DIRECT_DEPLOYMENT_WORKER_NAME = 'ghostbuild-cloudflare-app';
const INVENTORY_EXISTING_LIMIT = 2;
const INVENTORY_DISCOVERY_LIMIT = 2;
const INVENTORY_PROVIDER_CONCURRENCY = 2;
const MANAGED_ATTESTATION_ATTEMPTS = 6;
const MANAGED_ATTESTATION_RETRY_MS = 1_000;

type DeploymentSecurityInventoryStatus = 'current' | 'legacy_candidate' | 'drifted' | 'unreachable' | 'not_found';

type InventoryTarget = {
  id: string;
  user_id: string;
  account_id: string;
  credential_handle: string;
  worker_name: string;
  managed_deployment_id: string | null;
  expected_template_source_sha256: string | null;
  expected_security_baseline_version: number | null;
  expected_security_boundary_sha256: string | null;
  expected_agent_security_d1_id: string | null;
  requires_agent_cleanup: number;
  attested_worker_version_id: string | null;
  attested_script_etag: string | null;
};

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

/**
 * Durably queues the deterministic managed Worker name before the provider
 * mutation. This is an inspection intent, not evidence that the Worker exists
 * or satisfies the baseline; scheduled readback owns that classification.
 */
export async function recordManagedDeploymentSecurityIntent(args: {
  db: D1Database;
  deployment: Deployment;
  workerName: string;
  accountId: string;
  now?: number;
}): Promise<void> {
  await upsertInventory({
    db: args.db,
    connectionId: args.deployment.connectionId,
    workerName: args.workerName,
    userId: args.deployment.userId,
    accountId: args.accountId,
    managedDeploymentId: args.deployment.id,
    requiresAgentCleanup: args.deployment.plan.project?.bindings.appAgent ?? true,
    attestedWorkerVersionId: null,
    attestedScriptEtag: null,
    status: 'legacy_candidate',
    expectedTemplateSourceSha256: args.deployment.plan.templateSourceSha256,
    expectedSecurityBaselineVersion: args.deployment.plan.securityBaselineVersion,
    expectedSecurityBoundarySha256: args.deployment.plan.securityBoundarySha256,
    observedTemplateSourceSha256: null,
    observedSecurityBaselineVersion: null,
    observedSecurityBoundarySha256: null,
    providerDeploymentId: null,
    workerVersionId: null,
    scriptEtag: null,
    lastError: null,
    attestedAt: null,
    lastCheckedAt: 0,
    now: args.now,
  });
}

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

export async function recordManagedDeploymentSecurityAttestation(args: {
  db: D1Database;
  deployment: Deployment;
  workerName: string;
  accountId: string;
  readback: ActiveWorkerDeploymentReadback;
  expectedWorkerVersionId?: string;
  expectedScriptEtag?: string;
  expectedAgentSecurityD1DatabaseId?: string;
  now?: number;
}): Promise<DeploymentSecurityAttestation> {
  const attestation = evaluateDeploymentSecurityAttestation({
    readback: args.readback,
    expectedTemplateSourceSha256: args.deployment.plan.templateSourceSha256,
    expectedSecurityBaselineVersion: args.deployment.plan.securityBaselineVersion,
    expectedSecurityBoundarySha256: args.deployment.plan.securityBoundarySha256,
    expectedWorkerVersionId: args.expectedWorkerVersionId,
    expectedScriptEtag: args.expectedScriptEtag,
    expectedAgentSecurityD1DatabaseId: args.expectedAgentSecurityD1DatabaseId,
    requiresAgentCleanup: args.deployment.plan.project?.bindings.appAgent ?? true,
  });
  await upsertInventory({
    db: args.db,
    connectionId: args.deployment.connectionId,
    workerName: args.workerName,
    userId: args.deployment.userId,
    accountId: args.accountId,
    managedDeploymentId: args.deployment.id,
    requiresAgentCleanup: args.deployment.plan.project?.bindings.appAgent ?? true,
    attestedWorkerVersionId: attestation.status === 'current' ? attestation.workerVersionId : null,
    attestedScriptEtag: attestation.status === 'current' ? attestation.scriptEtag : null,
    attestedAt: attestation.status === 'current' ? (args.now ?? Date.now()) : null,
    ...attestation,
    lastError: null,
    now: args.now,
  });
  if (attestation.status !== 'current') {
    throw new DeploymentSecurityAttestationError('Published Worker security metadata did not match its approved plan.');
  }
  return attestation;
}

export async function attestManagedDeploymentSecurity(args: {
  db: D1Database;
  deployment: Deployment;
  workerName: string;
  accountId: string;
  accountApi: Pick<UserCloudflareAccountApi, 'readActiveWorkerDeployment'>;
  expectedPublishedVersionId: string;
  expectedAgentSecurityD1DatabaseId?: string;
  attempts?: number;
  retryDelay?: (milliseconds: number) => Promise<void>;
}): Promise<DeploymentSecurityAttestation> {
  const attempts = args.attempts ?? MANAGED_ATTESTATION_ATTEMPTS;
  const requiresAgentSecurityDb = args.deployment.plan.project?.bindings.appAgent ?? true;
  if (requiresAgentSecurityDb && !args.expectedAgentSecurityD1DatabaseId) {
    throw new DeploymentSecurityAttestationError(
      'Published AppAgent Worker is missing its provisioned agent security D1 identity.',
    );
  }
  const retryDelay =
    args.retryDelay ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let lastReadback: ActiveWorkerDeploymentReadback | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    lastReadback = await args.accountApi.readActiveWorkerDeployment(args.workerName);
    if (lastReadback) {
      const evaluated = evaluateDeploymentSecurityAttestation({
        readback: lastReadback,
        expectedTemplateSourceSha256: args.deployment.plan.templateSourceSha256,
        expectedSecurityBaselineVersion: args.deployment.plan.securityBaselineVersion,
        expectedSecurityBoundarySha256: args.deployment.plan.securityBoundarySha256,
        expectedWorkerVersionId: args.expectedPublishedVersionId,
        expectedAgentSecurityD1DatabaseId: args.expectedAgentSecurityD1DatabaseId,
        requiresAgentCleanup: args.deployment.plan.project?.bindings.appAgent ?? true,
      });
      if (evaluated.status === 'current') {
        return recordManagedDeploymentSecurityAttestation({
          ...args,
          readback: lastReadback,
          expectedWorkerVersionId: args.expectedPublishedVersionId,
          expectedAgentSecurityD1DatabaseId: args.expectedAgentSecurityD1DatabaseId,
        });
      }
    }
    if (attempt < attempts) {
      await retryDelay(MANAGED_ATTESTATION_RETRY_MS);
    }
  }
  if (!lastReadback) {
    throw new DeploymentSecurityAttestationError('Published Worker is unavailable for security attestation.');
  }
  return recordManagedDeploymentSecurityAttestation({
    ...args,
    readback: lastReadback,
    expectedWorkerVersionId: args.expectedPublishedVersionId,
    expectedAgentSecurityD1DatabaseId: args.expectedAgentSecurityD1DatabaseId,
  });
}

/**
 * Bounded, read-only provider discovery for the single historical direct-
 * deployment name. It never adopts, modifies, or redeploys a user's Worker.
 */
export async function refreshDeploymentSecurityInventoryBestEffort(env: Env): Promise<void> {
  if (!env.CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY) {
    return;
  }
  let targets: InventoryTarget[];
  try {
    const [existing, missingHistorical] = await Promise.all([
      env.DB.prepare(
        `SELECT connection.id, connection.user_id, connection.account_id, connection.credential_handle,
                  inventory.worker_name, inventory.managed_deployment_id,
                  inventory.expected_template_source_sha256, inventory.expected_security_baseline_version,
                  inventory.expected_security_boundary_sha256,
                  (SELECT security_resource.provider_resource_id
                   FROM deployment_resources AS security_resource
                   WHERE security_resource.deployment_id = inventory.managed_deployment_id
                     AND security_resource.resource_type = 'd1'
                     AND security_resource.logical_name = 'AGENT_SECURITY_DB'
                   LIMIT 1) AS expected_agent_security_d1_id,
                  inventory.requires_agent_cleanup,
                  inventory.attested_worker_version_id, inventory.attested_script_etag
           FROM deployment_security_inventory AS inventory
           JOIN cloudflare_connections AS connection ON connection.id = inventory.connection_id
           WHERE connection.status = 'active' AND connection.credential_handle IS NOT NULL
           ORDER BY inventory.last_checked_at, connection.id, inventory.worker_name
           LIMIT ?`,
      )
        .bind(INVENTORY_EXISTING_LIMIT)
        .all<InventoryTarget>(),
      env.DB.prepare(
        `SELECT connection.id, connection.user_id, connection.account_id, connection.credential_handle,
                  ? AS worker_name, NULL AS managed_deployment_id,
                  NULL AS expected_template_source_sha256, NULL AS expected_security_baseline_version,
                  NULL AS expected_security_boundary_sha256, NULL AS expected_agent_security_d1_id,
                  1 AS requires_agent_cleanup,
                  NULL AS attested_worker_version_id, NULL AS attested_script_etag
           FROM cloudflare_connections AS connection
           WHERE connection.status = 'active' AND connection.credential_handle IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM deployment_security_inventory AS inventory
               WHERE inventory.connection_id = connection.id AND inventory.worker_name = ?
             )
           ORDER BY connection.id
           LIMIT ?`,
      )
        .bind(
          HISTORICAL_DIRECT_DEPLOYMENT_WORKER_NAME,
          HISTORICAL_DIRECT_DEPLOYMENT_WORKER_NAME,
          INVENTORY_DISCOVERY_LIMIT,
        )
        .all<InventoryTarget>(),
    ]);
    targets = [...existing.results, ...missingHistorical.results];
  } catch (error) {
    console.error('Unable to list Cloudflare connections for deployment security inventory', error);
    return;
  }

  const { D1CloudflareCredentialVault } = await import('./cloudflare-credential-vault');
  const vault = D1CloudflareCredentialVault.fromEnv(env);
  for (let offset = 0; offset < targets.length; offset += INVENTORY_PROVIDER_CONCURRENCY) {
    await Promise.all(
      targets.slice(offset, offset + INVENTORY_PROVIDER_CONCURRENCY).map(async (connection) => {
        const now = Date.now();
        const expectedTemplateSourceSha256 = connection.expected_template_source_sha256 ?? TEMPLATE_SOURCE_SHA256;
        const expectedSecurityBaselineVersion =
          connection.expected_security_baseline_version ?? DEPLOYMENT_SECURITY_BASELINE_VERSION;
        const expectedSecurityBoundarySha256 =
          connection.expected_security_boundary_sha256 ?? APP_AGENT_SECURITY_BOUNDARY_SHA256;
        try {
          const token = await vault.resolve(connection.credential_handle);
          const readback = await new UserCloudflareAccountApi(connection.account_id, token).readActiveWorkerDeployment(
            connection.worker_name,
          );
          if (!readback) {
            const hasManagedPin = Boolean(
              connection.managed_deployment_id &&
              connection.attested_worker_version_id &&
              connection.attested_script_etag,
            );
            await upsertInventory({
              db: env.DB,
              connectionId: connection.id,
              workerName: connection.worker_name,
              userId: connection.user_id,
              accountId: connection.account_id,
              managedDeploymentId: connection.managed_deployment_id,
              requiresAgentCleanup: connection.requires_agent_cleanup === 1,
              attestedWorkerVersionId: connection.attested_worker_version_id,
              attestedScriptEtag: connection.attested_script_etag,
              status: hasManagedPin ? 'drifted' : 'not_found',
              expectedTemplateSourceSha256,
              expectedSecurityBaselineVersion,
              expectedSecurityBoundarySha256,
              observedTemplateSourceSha256: null,
              observedSecurityBaselineVersion: null,
              observedSecurityBoundarySha256: null,
              providerDeploymentId: null,
              workerVersionId: null,
              scriptEtag: null,
              lastError: null,
              attestedAt: null,
              now,
            });
            return;
          }
          const attestation = evaluateDeploymentSecurityAttestation({
            readback,
            expectedTemplateSourceSha256,
            expectedSecurityBaselineVersion,
            expectedSecurityBoundarySha256,
            requiresAgentCleanup: connection.requires_agent_cleanup === 1,
            requireExpectedAgentSecurityD1Identity: Boolean(
              connection.managed_deployment_id && connection.requires_agent_cleanup === 1,
            ),
            ...(connection.expected_agent_security_d1_id
              ? { expectedAgentSecurityD1DatabaseId: connection.expected_agent_security_d1_id }
              : {}),
            ...(connection.managed_deployment_id &&
            connection.attested_worker_version_id &&
            connection.attested_script_etag
              ? {
                  expectedWorkerVersionId: connection.attested_worker_version_id,
                  expectedScriptEtag: connection.attested_script_etag,
                }
              : {}),
          });
          const hasManagedPin = Boolean(
            connection.managed_deployment_id &&
            connection.attested_worker_version_id &&
            connection.attested_script_etag,
          );
          await upsertInventory({
            db: env.DB,
            connectionId: connection.id,
            workerName: connection.worker_name,
            userId: connection.user_id,
            accountId: connection.account_id,
            managedDeploymentId: connection.managed_deployment_id,
            requiresAgentCleanup: connection.requires_agent_cleanup === 1,
            attestedWorkerVersionId: connection.attested_worker_version_id,
            attestedScriptEtag: connection.attested_script_etag,
            ...attestation,
            status:
              attestation.status === 'current' && hasManagedPin
                ? 'current'
                : hasManagedPin
                  ? 'drifted'
                  : 'legacy_candidate',
            lastError: null,
            attestedAt: null,
            now,
          });
        } catch (error) {
          console.error('Unable to inspect Cloudflare deployment security state', connection.id, error);
          await upsertInventory({
            db: env.DB,
            connectionId: connection.id,
            workerName: connection.worker_name,
            userId: connection.user_id,
            accountId: connection.account_id,
            managedDeploymentId: connection.managed_deployment_id,
            requiresAgentCleanup: connection.requires_agent_cleanup === 1,
            attestedWorkerVersionId: connection.attested_worker_version_id,
            attestedScriptEtag: connection.attested_script_etag,
            status: 'unreachable',
            expectedTemplateSourceSha256,
            expectedSecurityBaselineVersion,
            expectedSecurityBoundarySha256,
            observedTemplateSourceSha256: null,
            observedSecurityBaselineVersion: null,
            observedSecurityBoundarySha256: null,
            providerDeploymentId: null,
            workerVersionId: null,
            scriptEtag: null,
            lastError: safeInventoryError(error),
            attestedAt: null,
            now,
          }).catch((persistError) =>
            console.error('Unable to persist deployment security inventory failure', persistError),
          );
        }
      }),
    );
  }
}

async function upsertInventory(args: {
  db: D1Database;
  connectionId: string;
  workerName: string;
  userId: string;
  accountId: string;
  managedDeploymentId: string | null;
  requiresAgentCleanup: boolean;
  attestedWorkerVersionId: string | null;
  attestedScriptEtag: string | null;
  status: DeploymentSecurityInventoryStatus;
  expectedTemplateSourceSha256: string;
  expectedSecurityBaselineVersion: number;
  expectedSecurityBoundarySha256: string;
  observedTemplateSourceSha256: string | null;
  observedSecurityBaselineVersion: number | null;
  observedSecurityBoundarySha256: string | null;
  providerDeploymentId: string | null;
  workerVersionId: string | null;
  scriptEtag: string | null;
  lastError: string | null;
  attestedAt: number | null;
  lastCheckedAt?: number;
  now?: number;
}): Promise<void> {
  const now = args.now ?? Date.now();
  await args.db
    .prepare(
      `INSERT INTO deployment_security_inventory (
         connection_id, worker_name, user_id, account_id, managed_deployment_id, requires_agent_cleanup, status,
         expected_template_source_sha256, expected_security_baseline_version, expected_security_boundary_sha256,
         observed_template_source_sha256, observed_security_baseline_version, observed_security_boundary_sha256,
         provider_deployment_id, attested_worker_version_id, attested_script_etag,
         worker_version_id, script_etag, last_error, attested_at,
         last_checked_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(connection_id, worker_name) DO UPDATE SET
         user_id = excluded.user_id,
         account_id = excluded.account_id,
         managed_deployment_id = excluded.managed_deployment_id,
         requires_agent_cleanup = excluded.requires_agent_cleanup,
         status = excluded.status,
         expected_template_source_sha256 = excluded.expected_template_source_sha256,
         expected_security_baseline_version = excluded.expected_security_baseline_version,
         expected_security_boundary_sha256 = excluded.expected_security_boundary_sha256,
         observed_template_source_sha256 = excluded.observed_template_source_sha256,
         observed_security_baseline_version = excluded.observed_security_baseline_version,
         observed_security_boundary_sha256 = excluded.observed_security_boundary_sha256,
         provider_deployment_id = excluded.provider_deployment_id,
         attested_worker_version_id = COALESCE(excluded.attested_worker_version_id, attested_worker_version_id),
         attested_script_etag = COALESCE(excluded.attested_script_etag, attested_script_etag),
         worker_version_id = excluded.worker_version_id,
         script_etag = excluded.script_etag,
         last_error = excluded.last_error,
         attested_at = COALESCE(excluded.attested_at, attested_at),
         last_checked_at = excluded.last_checked_at,
         updated_at = excluded.updated_at`,
    )
    .bind(
      args.connectionId,
      args.workerName,
      args.userId,
      args.accountId,
      args.managedDeploymentId,
      args.requiresAgentCleanup ? 1 : 0,
      args.status,
      args.expectedTemplateSourceSha256,
      args.expectedSecurityBaselineVersion,
      args.expectedSecurityBoundarySha256,
      args.observedTemplateSourceSha256,
      args.observedSecurityBaselineVersion,
      args.observedSecurityBoundarySha256,
      args.providerDeploymentId,
      args.attestedWorkerVersionId,
      args.attestedScriptEtag,
      args.workerVersionId,
      args.scriptEtag,
      args.lastError,
      args.attestedAt,
      args.lastCheckedAt ?? now,
      now,
      now,
    )
    .run();
}

function plainTextBinding(readback: ActiveWorkerDeploymentReadback, name: string): string | null {
  const matches = readback.bindings.filter((binding) => binding.name === name && binding.type === 'plain_text');
  return matches.length === 1 && typeof matches[0]?.text === 'string' ? matches[0].text : null;
}

function safeInventoryError(error: unknown): string {
  const fallback = error instanceof CloudflareAccountApiError ? error.message : 'Cloudflare deployment is unreachable.';
  return fallback
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-token]')
    .slice(0, 1_000);
}

export class DeploymentSecurityAttestationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeploymentSecurityAttestationError';
  }
}
