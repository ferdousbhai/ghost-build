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
import { validatePreparedDeploymentArtifact } from './deployment-artifact';
import { UserCloudflareAccountApi } from './user-account-api';
import { GHOSTBUILD_CONTROL_PLANE_ENDPOINT } from './user-workspace-runtime-policy';

type UserOwnedDeploymentArgs = {
  env: Env;
  deploymentId: string;
  userId: string;
  connectionId: string;
  executionGeneration: number;
  request?: typeof fetch;
};

/** Execute an approved build entirely in the user's workspace Sandbox. */
export async function terminalizeInterruptedUserOwnedDeployment(args: UserOwnedDeploymentArgs): Promise<Deployment> {
  const deployment = await requireDeployment(args.env.DB, args.deploymentId);
  requireExecutionIdentityForRecovery(deployment, args);
  const reference = parseWorkspaceReference(deployment.workspaceReference);
  const workspace = args.env.PROJECT_WORKSPACE.get(args.env.PROJECT_WORKSPACE.idFromName(reference.projectId));
  await workspace.terminalizeInterruptedDeploymentSession({
    sessionId: `${deployment.id}:${args.executionGeneration}`,
  });
  await transitionDeployment({
    db: args.env.DB,
    deploymentId: deployment.id,
    executionGeneration: args.executionGeneration,
    expectedStatus: deployment.status,
    nextStatus: 'failed',
    errorCode: 'cloudflare_cleanup_required',
    errorMessage: 'Deployment was interrupted. Retry to reconcile the exact revision.',
  });
  return requireDeployment(args.env.DB, deployment.id);
}

export async function executeUserOwnedDeployment(args: UserOwnedDeploymentArgs): Promise<Deployment> {
  let phase: DeploymentStatus = 'approved';
  let providerChangesPossible = false;
  let deploymentSession: { finish(status: 'completed' | 'failed'): Promise<void> } | null = null;
  try {
    const runtimeEnv = args.env;
    const connectionGeneration = Number(runtimeEnv.GHOSTBUILD_CONNECTION_GENERATION);
    if (
      runtimeEnv.GHOSTBUILD_USER_RUNTIME !== '1' ||
      runtimeEnv.GHOSTBUILD_USER_ID !== args.userId ||
      runtimeEnv.GHOSTBUILD_CONNECTION_ID !== args.connectionId ||
      !Number.isSafeInteger(connectionGeneration) ||
      connectionGeneration < 1 ||
      !runtimeEnv.CLOUDFLARE_ACCOUNT_ID ||
      runtimeEnv.GHOSTBUILD_CONTROL_PLANE_ENDPOINT !== GHOSTBUILD_CONTROL_PLANE_ENDPOINT ||
      !runtimeEnv.CONTROL_PLANE_SECRET ||
      !runtimeEnv.PROJECT_WORKSPACE
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
    const request = args.request ?? fetch;
    const accountId = runtimeEnv.CLOUDFLARE_ACCOUNT_ID;
    const accountApi = await createUserAccountApi(runtimeEnv, request);
    const reference = parseWorkspaceReference(deployment.workspaceReference);
    if (reference.revision !== deployment.plan.sourceSha256) {
      throw new Error('The approved deployment revision no longer matches its workspace reference.');
    }
    const workspace = runtimeEnv.PROJECT_WORKSPACE.get(runtimeEnv.PROJECT_WORKSPACE.idFromName(reference.projectId));
    const sessionId = (
      await workspace.beginDeploymentSession({
        operationId: `${deployment.id}:${args.executionGeneration}`,
        expectedWorkspaceRevision: reference.workspaceRevision,
        expectedSnapshotRevision: reference.revision,
      })
    ).sessionId;
    let sessionFinished = false;
    deploymentSession = {
      async finish(status) {
        if (sessionFinished) {
          return;
        }
        await workspace.finishDeploymentSession({ sessionId, status });
        sessionFinished = true;
      },
    };

    const d1Name = deploymentPlanResourceName(deployment.plan, 'd1', 'DB');
    const agentD1Name = deploymentPlanResourceName(deployment.plan, 'd1', 'AGENT_SECURITY_DB');
    const r2Name = deploymentPlanResourceName(deployment.plan, 'r2', 'APP_STORAGE');
    const kvName = deploymentPlanResourceName(deployment.plan, 'kv', 'APP_CACHE');
    providerChangesPossible = Boolean(d1Name || agentD1Name || r2Name || kvName);
    const d1 = d1Name ? await accountApi.ensureD1ForPlan(deployment.plan) : null;
    if (d1) {
      await recordResource(args.env.DB, deployment.id, 'd1', 'DB', d1.id);
    }
    const agentD1 = agentD1Name ? await accountApi.ensureD1ForPlan(deployment.plan, 'AGENT_SECURITY_DB') : null;
    if (agentD1) {
      await recordResource(args.env.DB, deployment.id, 'd1', 'AGENT_SECURITY_DB', agentD1.id);
    }
    const r2 = r2Name ? await accountApi.ensureR2ForPlan(deployment.plan) : null;
    if (r2) {
      await recordResource(args.env.DB, deployment.id, 'r2', 'APP_STORAGE', r2.id);
    }
    const kv = kvName ? await accountApi.ensureKvForPlan(deployment.plan) : null;
    if (kv) {
      await recordResource(args.env.DB, deployment.id, 'kv', 'APP_CACHE', kv.id);
    }
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
    const profile = deploymentProjectProfile(deployment.plan);
    const artifact = await validatePreparedDeploymentArtifact(
      await workspace.prepareDeploymentArtifact({
        sessionId,
        revision: reference.revision,
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
        kvNamespaceId: kv?.id,
        securityBaselineVersion: String(deployment.plan.securityBaselineVersion),
        securityBoundarySha256: deployment.plan.securityBoundarySha256,
        templateSourceSha256: deployment.plan.templateSourceSha256,
      }),
      { revision: reference.revision, projectType: profile.type },
    );

    // The build may take several minutes. Resolve again at the authenticated
    // boundary and force OAuth refresh, then retry once if Cloudflare still
    // reports that the access token expired.
    const publishApi = await createUserAccountApi(runtimeEnv, request, true);
    await workspace.assertDeploymentSession({ sessionId });
    if (d1) {
      await publishApi.applyD1Migrations(d1.id, artifact.migrations.DB);
    }
    if (agentD1) {
      await publishApi.applyD1Migrations(agentD1.id, artifact.migrations.AGENT_SECURITY_DB);
    }
    providerChangesPossible = true;
    const result = await publishApi.deployManagedWorker({
      workerName,
      projectType: profile.type,
      sourceSha256: reference.revision,
      mainModule: artifact.mainModule,
      modules: artifact.modules,
      assets: artifact.assets,
      workersAi: profile.bindings.ai,
      appAgent: profile.bindings.appAgent,
      d1DatabaseId: d1?.id,
      agentSecurityD1DatabaseId: agentD1?.id,
      r2BucketName: r2?.name,
      kvNamespaceId: kv?.id,
      securityBaselineVersion: String(deployment.plan.securityBaselineVersion),
      securityBoundarySha256: deployment.plan.securityBoundarySha256,
      templateSourceSha256: deployment.plan.templateSourceSha256,
    });
    await publishApi.configureManagedWorkerSchedule(workerName, profile.bindings.appAgent);
    await publishApi.enableWorkerSubdomain(workerName);
    await attestManagedDeploymentSecurity({
      deployment,
      workerName,
      accountApi: publishApi,
      expectedPublishedVersionId: result.workerVersionId,
      expectedAgentSecurityD1DatabaseId: agentD1?.id,
      expectedKvNamespaceId: kv?.id,
    });
    await recordResource(args.env.DB, deployment.id, 'worker', 'app', workerName);
    const workersSubdomain = await publishApi.getWorkersSubdomain();
    await transitionDeployment({
      db: args.env.DB,
      deploymentId: deployment.id,
      executionGeneration: args.executionGeneration,
      expectedStatus: 'deploying',
      nextStatus: 'succeeded',
      productionUrl: `https://${workerName}.${workersSubdomain}.workers.dev`,
    });
    await deploymentSession.finish('completed');
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
      }).catch(() => console.error('Unable to persist user-owned deployment failure'));
    }
    throw error;
  } finally {
    await deploymentSession
      ?.finish('failed')
      .catch(() => console.error('Unable to finalize ProjectWorkspace deployment session'));
  }
}

export async function resolveFreshCloudflareAccessToken(
  env: {
    GHOSTBUILD_CONTROL_PLANE_ENDPOINT?: string;
    CONTROL_PLANE_SECRET?: string;
    GHOSTBUILD_USER_ID?: string;
    GHOSTBUILD_CONNECTION_ID?: string;
    GHOSTBUILD_CONNECTION_GENERATION?: string;
  },
  request: typeof fetch = fetch,
  forceRefresh = false,
): Promise<string> {
  if (
    env.GHOSTBUILD_CONTROL_PLANE_ENDPOINT !== GHOSTBUILD_CONTROL_PLANE_ENDPOINT ||
    !env.CONTROL_PLANE_SECRET ||
    !env.GHOSTBUILD_USER_ID ||
    !env.GHOSTBUILD_CONNECTION_ID
  ) {
    throw new Error('Cloudflare connection is unavailable.');
  }
  const connectionGeneration = Number(env.GHOSTBUILD_CONNECTION_GENERATION);
  if (!Number.isSafeInteger(connectionGeneration) || connectionGeneration < 1) {
    throw new Error('Cloudflare connection is unavailable.');
  }
  const response = await request(`${GHOSTBUILD_CONTROL_PLANE_ENDPOINT}/api/cloudflare/runtime-credential`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.CONTROL_PLANE_SECRET}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      userId: env.GHOSTBUILD_USER_ID,
      connectionId: env.GHOSTBUILD_CONNECTION_ID,
      connectionGeneration,
      forceRefresh,
    }),
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('Cloudflare connection is unavailable.');
  }
  const cacheControl = response.headers.get('Cache-Control') ?? '';
  if (!containsNoStore(cacheControl)) {
    throw new Error('Cloudflare connection is unavailable.');
  }
  const body = await readBoundedCredentialResponse(response);
  if (
    !response.ok ||
    !body ||
    typeof body.accessToken !== 'string' ||
    body.accessToken.length < 1 ||
    body.accessToken.length > 4_096
  ) {
    throw new Error('Cloudflare connection is unavailable.');
  }
  return body.accessToken;
}

export async function createUserAccountApi(
  env: {
    GHOSTBUILD_CONTROL_PLANE_ENDPOINT?: string;
    CONTROL_PLANE_SECRET?: string;
    GHOSTBUILD_USER_ID?: string;
    GHOSTBUILD_CONNECTION_ID?: string;
    GHOSTBUILD_CONNECTION_GENERATION?: string;
    CLOUDFLARE_ACCOUNT_ID?: string;
  },
  request: typeof fetch,
  forceRefresh = false,
): Promise<UserCloudflareAccountApi> {
  if (!env.CLOUDFLARE_ACCOUNT_ID) {
    throw new Error('Cloudflare connection is unavailable.');
  }
  const accessToken = await resolveFreshCloudflareAccessToken(env, request, forceRefresh);
  return new UserCloudflareAccountApi(env.CLOUDFLARE_ACCOUNT_ID, accessToken, request, undefined, () =>
    resolveFreshCloudflareAccessToken(env, request, true),
  );
}

async function readBoundedCredentialResponse(response: Response): Promise<Record<string, unknown> | null> {
  const contentLength = Number(response.headers.get('Content-Length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > 8 * 1024) {
    return null;
  }
  if (!response.body) {
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > 8 * 1024) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function containsNoStore(value: string): boolean {
  return value
    .toLowerCase()
    .split(',')
    .some((directive) => directive.trim() === 'no-store');
}

function requireExecutionIdentityForRecovery(deployment: Deployment, args: UserOwnedDeploymentArgs): void {
  if (
    deployment.userId !== args.userId ||
    deployment.connectionId !== args.connectionId ||
    deployment.executionGeneration !== args.executionGeneration ||
    (deployment.status !== 'provisioning' && deployment.status !== 'deploying') ||
    !isCurrentDeploymentPlan(deployment.plan)
  ) {
    throw new Error('Deployment no longer matches the interrupted user-owned execution.');
  }
}

function requireExecutionIdentity(deployment: Deployment, args: UserOwnedDeploymentArgs): void {
  if (
    deployment.userId !== args.userId ||
    deployment.connectionId !== args.connectionId ||
    deployment.executionGeneration !== args.executionGeneration ||
    deployment.status !== 'approved' ||
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
  resourceType: 'worker' | 'd1' | 'r2' | 'kv',
  logicalName: string,
  providerResourceId: string,
) {
  return recordDeploymentResource({ db, deploymentId, resourceType, logicalName, providerResourceId });
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : 'User-owned deployment failed.').slice(-4_000);
}
