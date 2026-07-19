import { deleteObject } from '~/lib/cloudflare/data/object-storage.server';
import {
  deploymentBuildArtifactKey,
  DeploymentBuildArtifactError,
  loadDeploymentBuildArtifact,
  readStoredDeploymentBuildReceipt,
  storeDeploymentBuildArtifact,
  type DeploymentBuildReceipt,
} from './deployment-build-artifact';
import { buildDeploymentSnapshot } from './deployment-build-executor';
import { requireActiveCloudflareConnection } from './cloudflare-connection-repository';
import { D1CloudflareCredentialVault } from './cloudflare-credential-vault';
import { publishDeploymentBuild } from './deployment-publish-executor';
import { deploymentPlanResourceName } from './deployment-plan';
import {
  claimApprovedDeployment,
  clearDeploymentSnapshot,
  DeploymentConcurrencyLimitError,
  recordDeploymentResource,
  retainDeploymentBuildArtifactReference,
  requireDeployment,
  transitionDeployment,
  type Deployment,
  type DeploymentStatus,
} from './deployment-repository';
import { UserCloudflareAccountApi } from './user-account-api';

type DeploymentExecutionArgs = {
  env: Env;
  deploymentId: string;
  userId: string;
  connectionId: string;
  executionGeneration: number;
};

export async function buildApprovedDeploymentArtifact(args: DeploymentExecutionArgs): Promise<DeploymentBuildReceipt> {
  let phase: DeploymentStatus = 'approved';
  let artifactKey: string | null = null;
  try {
    const connection = await requireActiveCloudflareConnection(args.env.DB, args.connectionId);
    let deployment = await requireDeployment(args.env.DB, args.deploymentId);
    requireDeploymentExecutionIdentity(deployment, args, ['approved', 'provisioning', 'building']);
    if (connection.userId !== args.userId || connection.generation !== deployment.connectionGeneration) {
      throw new Error('Cloudflare connection is unavailable.');
    }
    if (deployment.status === 'approved') {
      deployment = await claimApprovedDeployment({
        db: args.env.DB,
        deploymentId: args.deploymentId,
        userId: args.userId,
        connectionId: args.connectionId,
        connectionGeneration: connection.generation,
        executionGeneration: args.executionGeneration,
      });
    }
    phase = deployment.status;
    if (!deployment.snapshotKey) {
      throw new Error('Deployment source snapshot is unavailable.');
    }
    artifactKey = deploymentBuildArtifactKey(deployment);
    await retainDeploymentBuildArtifactReference({
      db: args.env.DB,
      deploymentId: deployment.id,
      executionGeneration: args.executionGeneration,
      objectKey: artifactKey,
    });
    let storedReceipt: DeploymentBuildReceipt | null = null;
    try {
      storedReceipt = await readStoredDeploymentBuildReceipt({ env: args.env, deployment });
    } catch (error) {
      if (!(error instanceof DeploymentBuildArtifactError)) {
        throw error;
      }
      // Never trust an invalid object. The following conditional store either
      // recovers a competing valid winner or fails so this generation can be
      // marked failed before its immutable key is queued for cleanup.
    }
    if (storedReceipt) {
      if (deployment.status === 'building') {
        await transitionDeployment({
          db: args.env.DB,
          deploymentId: deployment.id,
          executionGeneration: args.executionGeneration,
          expectedStatus: 'building',
          nextStatus: 'provisioning',
        });
      }
      return storedReceipt;
    }
    if (deployment.status === 'provisioning') {
      await transitionDeployment({
        db: args.env.DB,
        deploymentId: deployment.id,
        executionGeneration: args.executionGeneration,
        expectedStatus: 'provisioning',
        nextStatus: 'building',
      });
      phase = 'building';
    }
    const build = await buildDeploymentSnapshot({
      env: args.env,
      deploymentId: deployment.id,
      snapshotKey: deployment.snapshotKey,
      expectedSourceSha256: deployment.plan.sourceSha256,
    });
    const receipt = await storeDeploymentBuildArtifact({ env: args.env, deployment, build });
    await transitionDeployment({
      db: args.env.DB,
      deploymentId: deployment.id,
      executionGeneration: args.executionGeneration,
      expectedStatus: 'building',
      nextStatus: 'provisioning',
    });
    return receipt;
  } catch (error) {
    const failurePersisted = await persistDeploymentFailure({
      args,
      phase,
      error,
      providerChangesPossible: false,
    });
    if (artifactKey && failurePersisted) {
      await releaseBuildArtifactBestEffort(args.env, artifactKey, args.deploymentId);
    }
    throw error;
  }
}

export async function publishApprovedDeploymentArtifact(
  args: DeploymentExecutionArgs & { receipt: DeploymentBuildReceipt },
): Promise<Deployment> {
  let phase: DeploymentStatus = 'provisioning';
  let providerChangesPossible = false;
  let artifactKey: string | null = null;
  let artifactVerified = false;
  let artifactReleased = false;
  try {
    let deployment = await requireDeployment(args.env.DB, args.deploymentId);
    requireDeploymentExecutionIdentity(deployment, args, ['provisioning', 'deploying', 'succeeded']);
    phase = deployment.status;
    artifactKey = deploymentBuildArtifactKey(deployment);
    if (deployment.status === 'succeeded') {
      artifactReleased = true;
      await releaseSourceSnapshotBestEffort(args.env, deployment);
      return deployment;
    }
    const build = await loadDeploymentBuildArtifact({ env: args.env, deployment, receipt: args.receipt });
    artifactVerified = true;

    if (!args.env.CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY) {
      throw new Error('Cloudflare credential encryption is not configured.');
    }
    const connection = await requireActiveCloudflareConnection(args.env.DB, deployment.connectionId);
    if (
      connection.userId !== args.userId ||
      connection.generation !== deployment.connectionGeneration ||
      !connection.credentialHandle
    ) {
      throw new Error('Cloudflare connection is unavailable.');
    }
    const accessToken = await D1CloudflareCredentialVault.fromEnv(args.env).resolve(connection.credentialHandle);
    const accountApi = new UserCloudflareAccountApi(connection.accountId, accessToken);
    if (deployment.status === 'deploying') {
      providerChangesPossible = true;
    }
    const needsD1 = Boolean(deploymentPlanResourceName(deployment.plan, 'd1', 'DB'));
    if (needsD1) {
      providerChangesPossible = true;
    }
    const d1 = needsD1 ? await accountApi.ensureD1ForPlan(deployment.plan) : null;
    if (d1) {
      await recordDeploymentResource({
        db: args.env.DB,
        deploymentId: deployment.id,
        resourceType: 'd1',
        logicalName: 'DB',
        providerResourceId: d1.id,
      });
    }
    const needsR2 = Boolean(deploymentPlanResourceName(deployment.plan, 'r2', 'APP_STORAGE'));
    if (needsR2) {
      providerChangesPossible = true;
    }
    const r2 = needsR2 ? await accountApi.ensureR2ForPlan(deployment.plan) : null;
    if (r2) {
      await recordDeploymentResource({
        db: args.env.DB,
        deploymentId: deployment.id,
        resourceType: 'r2',
        logicalName: 'APP_STORAGE',
        providerResourceId: r2.id,
      });
    }
    const workersSubdomain = await accountApi.getWorkersSubdomain();

    if (deployment.status === 'provisioning') {
      await transitionDeployment({
        db: args.env.DB,
        deploymentId: deployment.id,
        executionGeneration: args.executionGeneration,
        expectedStatus: 'provisioning',
        nextStatus: 'deploying',
      });
      phase = 'deploying';
    }
    deployment = await requireDeployment(args.env.DB, deployment.id);
    requireDeploymentExecutionIdentity(deployment, args, ['deploying']);
    providerChangesPossible = true;
    await publishDeploymentBuild({
      env: args.env,
      deployment,
      connection,
      build,
      d1DatabaseId: d1?.id,
      r2BucketName: r2?.name,
    });
    const workerName = deployment.plan.resources.find(
      (resource) => resource.type === 'worker' && resource.logicalName === 'app',
    )?.proposedName;
    if (!workerName) {
      throw new Error('Deployment Worker name is unavailable.');
    }
    await recordDeploymentResource({
      db: args.env.DB,
      deploymentId: deployment.id,
      resourceType: 'worker',
      logicalName: 'app',
      providerResourceId: workerName,
    });
    await transitionDeployment({
      db: args.env.DB,
      deploymentId: deployment.id,
      executionGeneration: args.executionGeneration,
      expectedStatus: 'deploying',
      nextStatus: 'succeeded',
      productionUrl: `https://${workerName}.${workersSubdomain}.workers.dev`,
    });
    artifactReleased = true;
    await releaseSourceSnapshotBestEffort(args.env, deployment);
    return requireDeployment(args.env.DB, deployment.id);
  } catch (error) {
    artifactReleased = await persistDeploymentFailure({
      args,
      phase,
      error,
      providerChangesPossible,
      errorCode: !artifactVerified ? 'deployment_build_artifact_invalid' : undefined,
    });
    throw error;
  } finally {
    if (artifactKey && artifactReleased) {
      await releaseBuildArtifactBestEffort(args.env, artifactKey, args.deploymentId);
    }
  }
}

function requireDeploymentExecutionIdentity(
  deployment: Deployment,
  args: Pick<DeploymentExecutionArgs, 'connectionId' | 'userId' | 'executionGeneration'>,
  expectedStatuses: DeploymentStatus[],
): void {
  if (
    deployment.userId !== args.userId ||
    deployment.connectionId !== args.connectionId ||
    deployment.executionGeneration !== args.executionGeneration ||
    !expectedStatuses.includes(deployment.status) ||
    !deployment.approvedDigest ||
    deployment.approvedDigest !== deployment.planDigest ||
    deployment.plan.deploymentId !== deployment.id
  ) {
    throw new Error('Deployment execution identity no longer matches the approved plan.');
  }
}

async function persistDeploymentFailure(args: {
  args: DeploymentExecutionArgs;
  phase: DeploymentStatus;
  error: unknown;
  providerChangesPossible: boolean;
  errorCode?: string;
}): Promise<boolean> {
  if (args.phase === 'approved' && args.error instanceof DeploymentConcurrencyLimitError) {
    try {
      await transitionDeployment({
        db: args.args.env.DB,
        deploymentId: args.args.deploymentId,
        executionGeneration: args.args.executionGeneration,
        expectedStatus: 'approved',
        nextStatus: 'failed',
        errorCode: 'deployment_concurrency_limited',
        errorMessage: args.error.message,
      });
      return true;
    } catch (transitionError) {
      console.error('Unable to persist deployment concurrency failure', transitionError);
      return false;
    }
  }
  if (args.phase === 'approved') {
    return false;
  }
  try {
    await transitionDeployment({
      db: args.args.env.DB,
      deploymentId: args.args.deploymentId,
      executionGeneration: args.args.executionGeneration,
      expectedStatus: args.phase,
      nextStatus: 'failed',
      errorCode: args.providerChangesPossible
        ? 'cloudflare_cleanup_required'
        : (args.errorCode ?? deploymentErrorCode(args.phase)),
      errorMessage: args.providerChangesPossible ? cleanupRequiredError(args.error) : safeDeploymentError(args.error),
    });
    return true;
  } catch (transitionError) {
    console.error('Unable to persist deployment failure', transitionError);
    return false;
  }
}

async function releaseSourceSnapshotBestEffort(env: Env, deployment: Deployment): Promise<void> {
  if (!deployment.snapshotKey) {
    return;
  }
  try {
    await deleteObject(env, deployment.snapshotKey);
    await clearDeploymentSnapshot({
      db: env.DB,
      deploymentId: deployment.id,
      snapshotKey: deployment.snapshotKey,
    });
  } catch (error) {
    console.error('Unable to release successful deployment snapshot', deployment.id, error);
  }
}

async function releaseBuildArtifactBestEffort(env: Env, objectKey: string, deploymentId: string): Promise<void> {
  try {
    await deleteObject(env, objectKey);
  } catch (error) {
    // Cleanup intent is durably queued before R2 storage and retained until
    // the exact generation reference is released. Never make deletion depend
    // on this best-effort fast path or a finally block completing.
    console.error('Unable to release deployment build artifact', deploymentId, error);
  }
}

function deploymentErrorCode(phase: DeploymentStatus): string {
  if (phase === 'provisioning') {
    return 'cloudflare_provisioning_failed';
  }
  if (phase === 'building') {
    return 'isolated_build_failed';
  }
  return 'cloudflare_publish_failed';
}

function cleanupRequiredError(error: unknown): string {
  return (
    'Cloudflare resources may have changed before the failure. Retry this deployment to reconcile its approved plan. ' +
    safeDeploymentError(error)
  ).slice(0, 4_000);
}

function safeDeploymentError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Deployment failed.';
  return message
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-token]')
    .slice(0, 4_000);
}
