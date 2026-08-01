import { deploymentPlanResourceName, deploymentProjectProfile, isCurrentDeploymentPlan } from './deployment-plan';
import {
  claimApprovedDeployment,
  recordDeploymentResource,
  requireDeployment,
  transitionDeployment,
  type Deployment,
  type DeploymentStatus,
} from './deployment-repository';
import { attestManagedDeploymentSecurity } from './deployment-security-inventory';
import { UserCloudflareAccountApi } from './user-account-api';

type UserOwnedDeploymentArgs = {
  env: Env;
  deploymentId: string;
  userId: string;
  connectionId: string;
  executionGeneration: number;
  request?: typeof fetch;
};

/** Execute an approved build entirely in the user's workspace Sandbox. */
export async function executeUserOwnedDeployment(args: UserOwnedDeploymentArgs): Promise<Deployment> {
  let phase: DeploymentStatus = 'approved';
  let providerChangesPossible = false;
  try {
    const runtimeEnv = args.env as Env & {
      GHOSTBUILD_USER_RUNTIME?: string;
      GHOSTBUILD_USER_RUNTIME_ENDPOINT?: string;
      CONTROL_PLANE_SECRET?: string;
      CLOUDFLARE_API_TOKEN?: string;
      CLOUDFLARE_ACCOUNT_ID?: string;
      GHOSTBUILD_USER_ID?: string;
      GHOSTBUILD_CONNECTION_ID?: string;
      GHOSTBUILD_CONNECTION_GENERATION?: string;
    };
    const connectionGeneration = Number(runtimeEnv.GHOSTBUILD_CONNECTION_GENERATION);
    if (
      runtimeEnv.GHOSTBUILD_USER_RUNTIME !== '1' ||
      runtimeEnv.GHOSTBUILD_USER_ID !== args.userId ||
      runtimeEnv.GHOSTBUILD_CONNECTION_ID !== args.connectionId ||
      !Number.isSafeInteger(connectionGeneration) ||
      connectionGeneration < 1 ||
      !runtimeEnv.CLOUDFLARE_ACCOUNT_ID ||
      !runtimeEnv.CLOUDFLARE_API_TOKEN ||
      !runtimeEnv.GHOSTBUILD_USER_RUNTIME_ENDPOINT ||
      !runtimeEnv.CONTROL_PLANE_SECRET
    ) {
      throw new Error('Cloudflare connection is unavailable.');
    }
    let deployment = await requireDeployment(args.env.DB, args.deploymentId);
    requireExecutionIdentity(deployment, args);
    deployment = await claimApprovedDeployment({
      db: args.env.DB,
      deploymentId: deployment.id,
      userId: args.userId,
      connectionId: args.connectionId,
      connectionGeneration,
      executionGeneration: args.executionGeneration,
    });
    phase = 'provisioning';
    const accessToken = runtimeEnv.CLOUDFLARE_API_TOKEN;
    const accountId = runtimeEnv.CLOUDFLARE_ACCOUNT_ID;
    const accountApi = new UserCloudflareAccountApi(accountId, accessToken);

    const d1Name = deploymentPlanResourceName(deployment.plan, 'd1', 'DB');
    const d1 = d1Name ? await accountApi.ensureD1ForPlan(deployment.plan) : null;
    if (d1) {
      await recordResource(args.env.DB, deployment.id, 'd1', 'DB', d1.id);
    }
    const agentD1Name = deploymentPlanResourceName(deployment.plan, 'd1', 'AGENT_SECURITY_DB');
    const agentD1 = agentD1Name ? await accountApi.ensureD1ForPlan(deployment.plan, 'AGENT_SECURITY_DB') : null;
    if (agentD1) {
      await recordResource(args.env.DB, deployment.id, 'd1', 'AGENT_SECURITY_DB', agentD1.id);
    }
    const r2Name = deploymentPlanResourceName(deployment.plan, 'r2', 'APP_STORAGE');
    const r2 = r2Name ? await accountApi.ensureR2ForPlan(deployment.plan) : null;
    if (r2) {
      await recordResource(args.env.DB, deployment.id, 'r2', 'APP_STORAGE', r2.id);
    }
    providerChangesPossible = Boolean(d1Name || agentD1Name || r2Name);

    await transitionDeployment({
      db: args.env.DB,
      deploymentId: deployment.id,
      executionGeneration: args.executionGeneration,
      expectedStatus: 'provisioning',
      nextStatus: 'deploying',
    });
    phase = 'deploying';
    deployment = await requireDeployment(args.env.DB, deployment.id);
    const workerName = requireResourceName(deployment, 'worker', 'app');
    providerChangesPossible = true;
    const reference = parseWorkspaceReference(deployment.workspaceReference);
    if (reference.revision !== deployment.plan.sourceSha256) {
      throw new Error('The approved deployment revision no longer matches its workspace reference.');
    }
    const secret = runtimeEnv.CONTROL_PLANE_SECRET;
    const profile = deploymentProjectProfile(deployment.plan);
    const response = await (args.request ?? fetch)(
      `${runtimeEnv.GHOSTBUILD_USER_RUNTIME_ENDPOINT}/v1/projects/${encodeURIComponent(reference.projectId)}/deploy`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          deploymentId: deployment.id,
          revision: reference.revision,
          apiToken: accessToken,
          accountId,
          workerName,
          projectType: profile.type,
          workersAi: profile.bindings.ai,
          appAgent: profile.bindings.appAgent,
          d1DatabaseId: d1?.id,
          d1DatabaseName: d1?.name,
          agentSecurityD1DatabaseId: agentD1?.id,
          agentSecurityD1DatabaseName: agentD1?.name,
          r2BucketName: r2?.name,
          securityBaselineVersion: String(deployment.plan.securityBaselineVersion),
          securityBoundarySha256: deployment.plan.securityBoundarySha256,
          templateSourceSha256: deployment.plan.templateSourceSha256,
        }),
        signal: AbortSignal.timeout(30 * 60_000),
      },
    );
    const result = (await response.json().catch(() => null)) as {
      workerName?: string;
      workerVersionId?: string;
      error?: string;
    } | null;
    if (!response.ok || result?.workerName !== workerName || typeof result.workerVersionId !== 'string') {
      throw new Error(result?.error || 'The user-owned deployment Sandbox failed.');
    }
    await attestManagedDeploymentSecurity({
      deployment,
      workerName,
      accountApi,
      expectedPublishedVersionId: result.workerVersionId,
      expectedAgentSecurityD1DatabaseId: agentD1?.id,
    });
    await recordResource(args.env.DB, deployment.id, 'worker', 'app', workerName);
    const workersSubdomain = await accountApi.getWorkersSubdomain();
    await transitionDeployment({
      db: args.env.DB,
      deploymentId: deployment.id,
      executionGeneration: args.executionGeneration,
      expectedStatus: 'deploying',
      nextStatus: 'succeeded',
      productionUrl: `https://${workerName}.${workersSubdomain}.workers.dev`,
    });
    return requireDeployment(args.env.DB, deployment.id);
  } catch (error) {
    if (phase !== 'approved') {
      await transitionDeployment({
        db: args.env.DB,
        deploymentId: args.deploymentId,
        executionGeneration: args.executionGeneration,
        expectedStatus: phase,
        nextStatus: 'failed',
        errorCode: providerChangesPossible ? 'cloudflare_cleanup_required' : `deployment_${phase}_failed`,
        errorMessage: safeError(error),
      }).catch((transitionError) => console.error('Unable to persist user-owned deployment failure', transitionError));
    }
    throw error;
  }
}

function requireExecutionIdentity(deployment: Deployment, args: UserOwnedDeploymentArgs): void {
  if (
    deployment.userId !== args.userId ||
    deployment.connectionId !== args.connectionId ||
    deployment.executionGeneration !== args.executionGeneration ||
    deployment.status !== 'approved' ||
    deployment.approvedDigest !== deployment.planDigest ||
    !isCurrentDeploymentPlan(deployment.plan)
  ) {
    throw new Error('Deployment no longer matches the approved user-owned execution.');
  }
}

function parseWorkspaceReference(value: string | null) {
  const match = /^workspace-runtime:([^:]+):(\d+):([a-f0-9]{64})$/.exec(value ?? '');
  if (!match) {
    throw new Error('The approved user-owned workspace reference is invalid.');
  }
  return { projectId: decodeURIComponent(match[1]!), workspaceRevision: Number(match[2]), revision: match[3]! };
}

function requireResourceName(deployment: Deployment, type: 'worker', logicalName: string): string {
  const name = deploymentPlanResourceName(deployment.plan, type, logicalName);
  if (!name) {
    throw new Error(`Approved deployment plan has an invalid ${type} resource.`);
  }
  return name;
}

function recordResource(
  db: D1Database,
  deploymentId: string,
  resourceType: 'worker' | 'd1' | 'r2',
  logicalName: string,
  providerResourceId: string,
) {
  return recordDeploymentResource({ db, deploymentId, resourceType, logicalName, providerResourceId });
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : 'User-owned deployment failed.').slice(-4_000);
}
