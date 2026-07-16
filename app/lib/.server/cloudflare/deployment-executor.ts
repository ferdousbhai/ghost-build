import { deleteObject } from '~/lib/cloudflare/data/object-storage.server';
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
  requireDeployment,
  transitionDeployment,
  type Deployment,
  type DeploymentStatus,
} from './deployment-repository';
import { UserCloudflareAccountApi } from './user-account-api';

export async function executeApprovedDeployment(args: {
  env: Env;
  deploymentId: string;
  userId: string;
  connectionId: string;
}): Promise<Deployment> {
  let phase: DeploymentStatus = 'approved';
  try {
    let deployment = await claimApprovedDeployment({
      db: args.env.DB,
      deploymentId: args.deploymentId,
      userId: args.userId,
      connectionId: args.connectionId,
      connectionGeneration: (await requireActiveCloudflareConnection(args.env.DB, args.connectionId)).generation,
    });
    phase = 'provisioning';
    if (!deployment.snapshotKey) {
      throw new Error('Deployment source snapshot is unavailable.');
    }
    const snapshotKey = deployment.snapshotKey;
    await transitionDeployment({
      db: args.env.DB,
      deploymentId: deployment.id,
      expectedStatus: 'provisioning',
      nextStatus: 'building',
    });
    phase = 'building';
    const build = await buildDeploymentSnapshot({
      env: args.env,
      deploymentId: deployment.id,
      snapshotKey,
      expectedSourceSha256: deployment.plan.sourceSha256,
    });

    await transitionDeployment({
      db: args.env.DB,
      deploymentId: deployment.id,
      expectedStatus: 'building',
      nextStatus: 'provisioning',
    });
    phase = 'provisioning';
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
    const d1 = deploymentPlanResourceName(deployment.plan, 'd1', 'DB')
      ? await accountApi.ensureD1ForPlan(deployment.plan)
      : null;
    if (d1) {
      await recordDeploymentResource({
        db: args.env.DB,
        deploymentId: deployment.id,
        resourceType: 'd1',
        logicalName: 'DB',
        providerResourceId: d1.id,
      });
    }
    const r2 = deploymentPlanResourceName(deployment.plan, 'r2', 'APP_STORAGE')
      ? await accountApi.ensureR2ForPlan(deployment.plan)
      : null;
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

    await transitionDeployment({
      db: args.env.DB,
      deploymentId: deployment.id,
      expectedStatus: 'provisioning',
      nextStatus: 'deploying',
    });
    phase = 'deploying';
    deployment = await requireDeployment(args.env.DB, deployment.id);
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
      expectedStatus: 'deploying',
      nextStatus: 'succeeded',
      productionUrl: `https://${workerName}.${workersSubdomain}.workers.dev`,
    });
    try {
      await deleteObject(args.env, snapshotKey);
      await clearDeploymentSnapshot({
        db: args.env.DB,
        deploymentId: deployment.id,
        snapshotKey,
      });
    } catch (error) {
      console.error('Unable to release successful deployment snapshot', deployment.id, error);
    }
    return requireDeployment(args.env.DB, deployment.id);
  } catch (error) {
    if (phase === 'approved' && error instanceof DeploymentConcurrencyLimitError) {
      await transitionDeployment({
        db: args.env.DB,
        deploymentId: args.deploymentId,
        expectedStatus: 'approved',
        nextStatus: 'failed',
        errorCode: 'deployment_concurrency_limited',
        errorMessage: error.message,
      }).catch((transitionError) => console.error('Unable to persist deployment concurrency failure', transitionError));
    }
    if (phase !== 'approved') {
      await transitionDeployment({
        db: args.env.DB,
        deploymentId: args.deploymentId,
        expectedStatus: phase,
        nextStatus: 'failed',
        errorCode: deploymentErrorCode(phase),
        errorMessage: safeDeploymentError(error),
      }).catch((transitionError) => console.error('Unable to persist deployment failure', transitionError));
    }
    throw error;
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

function safeDeploymentError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Deployment failed.';
  return message
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-token]')
    .slice(0, 4_000);
}
