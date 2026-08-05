import { z } from 'zod';
import { buildDeploymentPlanFromSource, isCurrentDeploymentPlan } from '~/lib/.server/cloudflare/deployment-plan';
import type { DeploymentProjectProfile } from '~/lib/.server/cloudflare/deployment-project-profile';
import {
  approveDeployment,
  createDeployment,
  DeploymentApprovalDigestMismatchError,
  DeploymentConcurrencyLimitError,
  DeploymentConnectionChangedError,
  DeploymentNotFoundError,
  DeploymentStateConflictError,
  prepareDeploymentRetry,
  requireDeploymentForUser,
  type Deployment,
} from '~/lib/.server/cloudflare/deployment-repository';
import { findChat } from '~/lib/cloudflare/data/chat-repository.server';
import { InvalidJsonBodyError, PayloadTooLargeError, readJsonBodyWithLimit } from '~/lib/bounded-body';
import { executeUserOwnedDeployment } from '~/lib/.server/cloudflare/user-workspace-deployment-executor';

const MAX_DEPLOYMENT_APPROVAL_BYTES = 4 * 1024;
const approvalSchema = z.object({
  planDigest: z.string().regex(/^[a-f0-9]{64}$/),
  confirmCloudflareBilling: z.literal(true),
  confirmWorkersPaidNotAutomatic: z.literal(true),
});

export async function createOrReplayDeploymentPlanForUser(args: {
  env: Env;
  userId: string;
  chatId: string;
  deploymentId: string;
  projectId?: string;
  revision?: string;
  workspaceRevision?: number;
  project?: DeploymentProjectProfile;
}) {
  try {
    const existing = await requireDeploymentForUser(args.env.DB, args.deploymentId, args.userId);
    if (existing.workspaceReference === workspaceReference(requireWorkspaceDeploymentArgs(args))) {
      return publicDeployment(existing);
    }
  } catch (error) {
    if (!(error instanceof DeploymentNotFoundError)) {
      throw error;
    }
  }
  const workspaceArgs = requireWorkspaceDeploymentArgs(args);
  return createFreshWorkspaceDeploymentPlanForUser(workspaceArgs);
}

function requireWorkspaceDeploymentArgs(args: {
  env: Env;
  userId: string;
  chatId: string;
  deploymentId: string;
  projectId?: string;
  revision?: string;
  workspaceRevision?: number;
  project?: DeploymentProjectProfile;
}) {
  if (
    typeof args.projectId !== 'string' ||
    typeof args.revision !== 'string' ||
    typeof args.workspaceRevision !== 'number' ||
    !args.project
  ) {
    throw new Error('The user-owned workspace deployment reference is incomplete.');
  }
  return {
    ...args,
    projectId: args.projectId,
    revision: args.revision,
    workspaceRevision: args.workspaceRevision,
    project: args.project,
  };
}

async function createFreshWorkspaceDeploymentPlanForUser(args: {
  env: Env;
  userId: string;
  chatId: string;
  deploymentId: string;
  projectId: string;
  revision: string;
  workspaceRevision: number;
  project: DeploymentProjectProfile;
}) {
  const connection = runtimeCloudflareIdentity(args.env, args.userId);
  const chat = await findChat(args.env.DB, { id: args.chatId, sessionId: args.userId });
  if (!chat) {
    throw new DeploymentChatNotFoundError();
  }
  const { plan, digest } = await buildDeploymentPlanFromSource({
    deploymentId: args.deploymentId,
    sourceSha256: args.revision,
    project: args.project,
  });
  const deployment = await createDeployment({
    db: args.env.DB,
    id: args.deploymentId,
    chatId: chat.id,
    userId: args.userId,
    connectionId: connection.id,
    connectionGeneration: connection.generation,
    workspaceReference: workspaceReference(args),
    plan,
    planDigest: digest,
  });
  return publicDeployment(deployment);
}

function workspaceReference(args: { projectId: string; revision: string; workspaceRevision: number }): string {
  if (!/^[a-f0-9]{64}$/.test(args.revision) || !Number.isSafeInteger(args.workspaceRevision)) {
    throw new Error('The user-owned workspace deployment reference is invalid.');
  }
  return `workspace-runtime:${encodeURIComponent(args.projectId)}:${args.workspaceRevision}:${args.revision}`;
}

export async function userRuntimeDeploymentAction(args: {
  request: Request;
  env: Env;
  deploymentId: string;
  operation: 'get' | 'approve' | 'execute' | 'retry';
  userId: string;
}): Promise<Response> {
  try {
    return await runDeploymentAction(args);
  } catch (error) {
    return deploymentErrorResponse(error);
  }
}

async function runDeploymentAction(args: {
  request: Request;
  env: Env;
  deploymentId: string;
  operation: 'get' | 'approve' | 'execute' | 'retry';
  userId: string;
}): Promise<Response> {
  const userId = args.userId;
  if (args.operation === 'get') {
    const deployment = await requireDeploymentForUser(args.env.DB, args.deploymentId, userId);
    return Response.json({ deployment: publicDeployment(deployment) });
  }

  const connection = runtimeCloudflareIdentity(args.env, userId);
  const currentDeployment = await requireDeploymentForUser(args.env.DB, args.deploymentId, userId);
  if (!isCurrentDeploymentPlan(currentDeployment.plan)) {
    return Response.json(
      {
        code: 'deployment_plan_stale',
        error: 'Deployment plan security baseline is stale. Prepare and approve a new plan.',
      },
      { status: 409 },
    );
  }
  if (args.operation === 'retry') {
    const previous = currentDeployment;
    if (previous.connectionId !== connection.id || previous.connectionGeneration !== connection.generation) {
      throw new DeploymentConnectionChangedError();
    }
    const retry = await prepareDeploymentRetry({
      db: args.env.DB,
      deploymentId: previous.id,
      userId,
      connectionId: connection.id,
      connectionGeneration: connection.generation,
      executionGeneration: previous.executionGeneration,
    });
    return Response.json({ deployment: publicDeployment(retry) }, { status: 201 });
  }
  if (args.operation === 'execute') {
    const deployment = currentDeployment;
    if (
      deployment.connectionId !== connection.id ||
      deployment.connectionGeneration !== connection.generation ||
      deployment.status !== 'approved' ||
      !deployment.approvedAt
    ) {
      throw new DeploymentStateConflictError(deployment.status);
    }
    const completed = await executeUserOwnedDeployment({
      env: args.env,
      deploymentId: deployment.id,
      userId,
      connectionId: connection.id,
      executionGeneration: deployment.executionGeneration,
    });
    return Response.json({ deployment: publicDeployment(completed) });
  }
  const approval = approvalSchema.parse(
    await readJsonBodyWithLimit(args.request, MAX_DEPLOYMENT_APPROVAL_BYTES, 'Deployment approval'),
  );
  const deployment = await approveDeployment({
    db: args.env.DB,
    deploymentId: args.deploymentId,
    userId,
    connectionId: connection.id,
    connectionGeneration: connection.generation,
    approvedDigest: approval.planDigest,
  });
  return Response.json({ deployment: publicDeployment(deployment) });
}

class DeploymentConnectionRequiredError extends Error {}
class DeploymentChatNotFoundError extends Error {}

function runtimeCloudflareIdentity(env: Env, userId: string): { id: string; generation: number } {
  const runtime = env as Env & {
    GHOSTBUILD_USER_RUNTIME?: string;
    GHOSTBUILD_USER_ID?: string;
    GHOSTBUILD_CONNECTION_ID?: string;
    GHOSTBUILD_CONNECTION_GENERATION?: string;
  };
  const generation = Number(runtime.GHOSTBUILD_CONNECTION_GENERATION);
  if (
    runtime.GHOSTBUILD_USER_RUNTIME !== '1' ||
    runtime.GHOSTBUILD_USER_ID !== userId ||
    !runtime.GHOSTBUILD_CONNECTION_ID ||
    !Number.isSafeInteger(generation) ||
    generation < 1
  ) {
    throw new DeploymentConnectionRequiredError();
  }
  return { id: runtime.GHOSTBUILD_CONNECTION_ID, generation };
}

function publicDeployment(deployment: Deployment) {
  return {
    id: deployment.id,
    status: deployment.status,
    plan: deployment.plan,
    planDigest: deployment.planDigest,
    approvedAt: deployment.approvedAt,
    productionUrl: deployment.productionUrl,
    error: deployment.errorCode
      ? { code: deployment.errorCode, message: deployment.errorMessage ?? 'Deployment failed.' }
      : null,
    createdAt: deployment.createdAt,
    updatedAt: deployment.updatedAt,
  };
}

function deploymentErrorResponse(error: unknown): Response {
  if (error instanceof DeploymentConnectionRequiredError) {
    return Response.json({ error: 'Connect Cloudflare before preparing a production deployment.' }, { status: 409 });
  }
  if (error instanceof DeploymentChatNotFoundError) {
    return Response.json({ error: 'Chat not found.' }, { status: 404 });
  }
  if (error instanceof PayloadTooLargeError) {
    return Response.json({ error: error.message }, { status: 413 });
  }
  if (error instanceof InvalidJsonBodyError) {
    return Response.json({ error: 'Invalid deployment request.' }, { status: 400 });
  }
  if (error instanceof z.ZodError) {
    return Response.json({ error: 'Invalid deployment request.', issues: error.issues }, { status: 400 });
  }
  if (error instanceof DeploymentNotFoundError) {
    return Response.json({ error: error.message }, { status: 404 });
  }
  if (
    error instanceof DeploymentApprovalDigestMismatchError ||
    error instanceof DeploymentConcurrencyLimitError ||
    error instanceof DeploymentConnectionChangedError ||
    error instanceof DeploymentStateConflictError
  ) {
    return Response.json({ error: error.message }, { status: 409 });
  }
  console.error('Deployment request failed');
  return Response.json({ error: 'Unable to process the deployment.' }, { status: 500 });
}
