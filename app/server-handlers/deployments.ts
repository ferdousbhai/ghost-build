import { z } from 'zod';
import { resolveAgentRequestIdentity } from '~/lib/.server/agent-request-identity';
import { findCloudflareConnectionForUser } from '~/lib/.server/cloudflare/cloudflare-connection-repository';
import { buildDeploymentPlan } from '~/lib/.server/cloudflare/deployment-plan';
import { DeploymentSnapshotError } from '~/lib/.server/cloudflare/deployment-snapshot';
import {
  approveDeployment,
  createDeployment,
  clearDeploymentSnapshot,
  claimDeploymentSnapshotForRelease,
  DeploymentApprovalDigestMismatchError,
  DeploymentConcurrencyLimitError,
  DeploymentConnectionChangedError,
  DeploymentNotFoundError,
  DeploymentStateConflictError,
  DeploymentSnapshotLimitError,
  claimOldestReplaceableDeploymentSnapshot,
  listExpiredDeploymentSnapshots,
  prepareDeploymentRetry,
  requireDeploymentForUser,
  type Deployment,
} from '~/lib/.server/cloudflare/deployment-repository';
import { deleteObject, putObject } from '~/lib/cloudflare/data/object-storage.server';

const MAX_DEPLOYMENT_SNAPSHOT_BYTES = 10 * 1024 * 1024;
const DEPLOYMENT_SNAPSHOT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const createQuerySchema = z.object({ chatId: z.string().min(1).max(200) });
const approvalSchema = z.object({
  planDigest: z.string().regex(/^[a-f0-9]{64}$/),
  confirmCloudflareBilling: z.literal(true),
  confirmWorkersPaidNotAutomatic: z.literal(true),
});

export async function createDeploymentPlanAction(args: { request: Request; env: Env }): Promise<Response> {
  try {
    const userId = await requireSignedInUser(args.request, args.env);
    const { chatId } = createQuerySchema.parse(Object.fromEntries(new URL(args.request.url).searchParams));
    const connection = await findCloudflareConnectionForUser(args.env.DB, userId);
    if (!connection || connection.status !== 'active') {
      return Response.json({ error: 'Connect Cloudflare before preparing a production deployment.' }, { status: 409 });
    }
    const chat = await args.env.DB.prepare(
      `SELECT id FROM chats
       WHERE creator_id = ? AND (initial_id = ? OR url_id = ?) AND is_deleted = 0
       LIMIT 1`,
    )
      .bind(userId, chatId, chatId)
      .first<{ id: string }>();
    if (!chat) {
      return Response.json({ error: 'Chat not found.' }, { status: 404 });
    }

    const formData = await args.request.formData();
    const snapshot = formData.get('snapshot');
    if (!(snapshot instanceof Blob) || snapshot.size === 0 || snapshot.size > MAX_DEPLOYMENT_SNAPSHOT_BYTES) {
      return Response.json(
        { error: 'A non-empty deployment snapshot of at most 10 MiB is required.' },
        { status: 400 },
      );
    }
    await cleanupExpiredDeploymentSnapshots(args.env, userId);
    await releaseOldestReplaceableSnapshot(args.env, userId);

    const deploymentId = crypto.randomUUID();
    const { plan, digest } = await buildDeploymentPlan({ deploymentId, snapshot });
    let snapshotKey: string | null = null;
    try {
      snapshotKey = await putObject(args.env, 'deployment-snapshots', snapshot);
      const deployment = await createDeployment({
        db: args.env.DB,
        id: deploymentId,
        chatId: chat.id,
        userId,
        connectionId: connection.id,
        connectionGeneration: connection.generation,
        snapshotKey,
        plan,
        planDigest: digest,
      });
      return Response.json({ deployment: publicDeployment(deployment) }, { status: 201 });
    } catch (error) {
      if (snapshotKey) {
        await deleteObject(args.env, snapshotKey).catch(() => undefined);
      }
      throw error;
    }
  } catch (error) {
    return deploymentErrorResponse(error);
  }
}

async function releaseOldestReplaceableSnapshot(env: Env, userId: string): Promise<void> {
  const snapshot = await claimOldestReplaceableDeploymentSnapshot({ db: env.DB, userId });
  if (!snapshot) {
    return;
  }
  await deleteObject(env, snapshot.snapshotKey);
  await clearDeploymentSnapshot({
    db: env.DB,
    deploymentId: snapshot.deploymentId,
    snapshotKey: snapshot.snapshotKey,
  });
}

async function cleanupExpiredDeploymentSnapshots(env: Env, userId: string): Promise<void> {
  const expired = await listExpiredDeploymentSnapshots({
    db: env.DB,
    userId,
    updatedBefore: Date.now() - DEPLOYMENT_SNAPSHOT_RETENTION_MS,
  });
  for (const snapshot of expired) {
    try {
      const claimed = await claimDeploymentSnapshotForRelease({
        db: env.DB,
        deploymentId: snapshot.deploymentId,
        snapshotKey: snapshot.snapshotKey,
        updatedBefore: Date.now() - DEPLOYMENT_SNAPSHOT_RETENTION_MS,
      });
      if (!claimed) {
        continue;
      }
      await deleteObject(env, claimed.snapshotKey);
      await clearDeploymentSnapshot({
        db: env.DB,
        deploymentId: claimed.deploymentId,
        snapshotKey: claimed.snapshotKey,
      });
    } catch (error) {
      console.error('Unable to expire deployment snapshot', snapshot.deploymentId, error);
    }
  }
}

export async function deploymentAction(args: {
  request: Request;
  env: Env;
  deploymentId: string;
  operation: 'get' | 'approve' | 'execute' | 'retry';
}): Promise<Response> {
  try {
    const userId = await requireSignedInUser(args.request, args.env);
    if (args.operation === 'get') {
      const deployment = await requireDeploymentForUser(args.env.DB, args.deploymentId, userId);
      return Response.json({ deployment: publicDeployment(deployment) });
    }

    const connection = await findCloudflareConnectionForUser(args.env.DB, userId);
    if (!connection || connection.status !== 'active') {
      return Response.json({ error: 'Reconnect Cloudflare before approving this deployment.' }, { status: 409 });
    }
    if (args.operation === 'retry') {
      const previous = await requireDeploymentForUser(args.env.DB, args.deploymentId, userId);
      if (!['failed', 'canceled'].includes(previous.status) || !previous.snapshotKey) {
        throw new DeploymentStateConflictError(previous.status);
      }
      if (previous.connectionId !== connection.id || previous.connectionGeneration !== connection.generation) {
        throw new DeploymentConnectionChangedError();
      }
      const retry = await prepareDeploymentRetry({
        db: args.env.DB,
        deploymentId: previous.id,
        userId,
        connectionId: connection.id,
        connectionGeneration: connection.generation,
      });
      return Response.json({ deployment: publicDeployment(retry) }, { status: 201 });
    }
    if (args.operation === 'execute') {
      if (!args.env.DeploymentWorkflow) {
        return Response.json({ error: 'Production deployment Workflow is not configured.' }, { status: 503 });
      }
      const deployment = await requireDeploymentForUser(args.env.DB, args.deploymentId, userId);
      if (
        deployment.connectionId !== connection.id ||
        deployment.connectionGeneration !== connection.generation ||
        deployment.status !== 'approved' ||
        !deployment.approvedAt
      ) {
        throw new DeploymentStateConflictError(deployment.status);
      }
      await args.env.DeploymentWorkflow.createBatch([
        {
          id: `${deployment.id}-${deployment.approvedAt}`,
          params: { deploymentId: deployment.id, userId, connectionId: connection.id },
        },
      ]);
      return Response.json({ deployment: publicDeployment(deployment) }, { status: 202 });
    }
    const approval = approvalSchema.parse(await args.request.json());
    const deployment = await approveDeployment({
      db: args.env.DB,
      deploymentId: args.deploymentId,
      userId,
      connectionId: connection.id,
      connectionGeneration: connection.generation,
      approvedDigest: approval.planDigest,
    });
    return Response.json({ deployment: publicDeployment(deployment) });
  } catch (error) {
    return deploymentErrorResponse(error);
  }
}

async function requireSignedInUser(request: Request, env: Env): Promise<string> {
  const identity = await resolveAgentRequestIdentity(request, env);
  if (!identity?.userId) {
    throw new DeploymentAuthenticationError();
  }
  return identity.userId;
}

class DeploymentAuthenticationError extends Error {}

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
  if (error instanceof DeploymentAuthenticationError) {
    return Response.json({ error: 'Sign in to deploy to production.' }, { status: 401 });
  }
  if (error instanceof z.ZodError) {
    return Response.json({ error: 'Invalid deployment request.', issues: error.issues }, { status: 400 });
  }
  if (error instanceof DeploymentSnapshotError) {
    return Response.json({ error: error.message }, { status: 400 });
  }
  if (error instanceof DeploymentNotFoundError) {
    return Response.json({ error: error.message }, { status: 404 });
  }
  if (
    error instanceof DeploymentApprovalDigestMismatchError ||
    error instanceof DeploymentConcurrencyLimitError ||
    error instanceof DeploymentConnectionChangedError ||
    error instanceof DeploymentSnapshotLimitError ||
    error instanceof DeploymentStateConflictError
  ) {
    return Response.json({ error: error.message }, { status: 409 });
  }
  console.error('Deployment request failed', error);
  return Response.json({ error: 'Unable to process the deployment.' }, { status: 500 });
}
