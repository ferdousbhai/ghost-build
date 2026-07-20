import { z } from 'zod';
import { resolveAgentRequestIdentity } from '~/lib/.server/agent-request-identity';
import { findCloudflareConnectionForUser } from '~/lib/.server/cloudflare/cloudflare-connection-repository';
import { buildDeploymentPlan, isCurrentDeploymentPlan } from '~/lib/.server/cloudflare/deployment-plan';
import { DeploymentSnapshotError } from '~/lib/.server/cloudflare/deployment-snapshot';
import {
  adoptLegacyApprovedDeploymentExecutionGeneration,
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
import { InvalidJsonBodyError, PayloadTooLargeError, readJsonBodyWithLimit } from '~/lib/bounded-body';
import { InvalidMultipartBodyError, readMultipartBodyWithLimits } from '~/lib/bounded-multipart';
import { deleteObject, putObjectAtKey } from '~/lib/cloudflare/data/object-storage.server';
import { cancelObjectGcCandidate, queueObjectGcCandidate } from '~/lib/cloudflare/data/object-gc.server';

const MAX_DEPLOYMENT_SNAPSHOT_BYTES = 10 * 1024 * 1024;
const MAX_DEPLOYMENT_REQUEST_BYTES = MAX_DEPLOYMENT_SNAPSHOT_BYTES + 1024 * 1024;
const MAX_DEPLOYMENT_APPROVAL_BYTES = 4 * 1024;
const DEPLOYMENT_FORM_FIELDS = {
  snapshot: { kind: 'file', maximumBytes: MAX_DEPLOYMENT_SNAPSHOT_BYTES },
} as const;
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

    const formData = await readBoundedDeploymentFormData(args.request);
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
    const snapshotKey = `deployment-snapshots/${deploymentId}`;
    const gcReceipt = await queueObjectGcCandidate(args.env.DB, snapshotKey);
    await putObjectAtKey(args.env, snapshotKey, snapshot);
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
    await cancelObjectGcCandidate(args.env.DB, gcReceipt).catch((error) => {
      console.warn('Unable to cancel deployment snapshot cleanup receipt', deploymentId, error);
    });
    return Response.json({ deployment: publicDeployment(deployment) }, { status: 201 });
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
      if (!previous.snapshotKey) {
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
        executionGeneration: previous.executionGeneration,
      });
      return Response.json({ deployment: publicDeployment(retry) }, { status: 201 });
    }
    if (args.operation === 'execute') {
      if (!args.env.DeploymentWorkflow) {
        return Response.json({ error: 'Production deployment Workflow is not configured.' }, { status: 503 });
      }
      let deployment = currentDeployment;
      if (
        deployment.connectionId !== connection.id ||
        deployment.connectionGeneration !== connection.generation ||
        deployment.status !== 'approved' ||
        !deployment.approvedAt
      ) {
        throw new DeploymentStateConflictError(deployment.status);
      }
      deployment = await adoptLegacyApprovedDeploymentExecutionGeneration({ db: args.env.DB, deployment });
      const workflowId = `${deployment.id}-${deployment.executionGeneration}`;
      // createBatch is intentionally used instead of create: Cloudflare
      // idempotently skips a retained instance with this deterministic ID.
      const createdInstances = await args.env.DeploymentWorkflow.createBatch([
        {
          id: workflowId,
          params: {
            deploymentId: deployment.id,
            userId,
            connectionId: connection.id,
            executionGeneration: deployment.executionGeneration,
          },
        },
      ]);
      if (createdInstances.length === 0) {
        await restartRetainedDeploymentWorkflowIfSafe({
          db: args.env.DB,
          workflow: args.env.DeploymentWorkflow,
          workflowId,
          expectedDeployment: deployment,
          userId,
        });
      }
      return Response.json({ deployment: publicDeployment(deployment) }, { status: 202 });
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
  } catch (error) {
    return deploymentErrorResponse(error);
  }
}

async function restartRetainedDeploymentWorkflowIfSafe(args: {
  db: D1Database;
  workflow: Env['DeploymentWorkflow'];
  workflowId: string;
  expectedDeployment: Deployment;
  userId: string;
}): Promise<void> {
  const instance = await args.workflow.get(args.workflowId);
  const initialStatus = (await instance.status()).status;
  if (initialStatus === 'unknown') {
    throw new Error(`Unable to determine retained deployment Workflow status for ${args.workflowId}.`);
  }
  if (initialStatus !== 'errored' && initialStatus !== 'terminated') {
    return;
  }

  const current = await requireDeploymentForUser(args.db, args.expectedDeployment.id, args.userId);
  if (!isSameApprovedExecution(current, args.expectedDeployment, args.userId)) {
    return;
  }

  try {
    await instance.restart();
  } catch (error) {
    // Another repeated execute request may have restarted the same retained
    // instance after our status check. Treat that race as the same idempotent
    // success, but preserve genuine restart failures.
    const statusAfterFailure = (await instance.status()).status;
    if (statusAfterFailure !== 'errored' && statusAfterFailure !== 'terminated' && statusAfterFailure !== 'unknown') {
      return;
    }
    throw error;
  }
}

function isSameApprovedExecution(current: Deployment, expected: Deployment, userId: string): boolean {
  return (
    current.id === expected.id &&
    current.userId === userId &&
    expected.userId === userId &&
    current.status === 'approved' &&
    current.executionGeneration === expected.executionGeneration &&
    current.approvedAt === expected.approvedAt &&
    current.approvedDigest === expected.approvedDigest &&
    current.planDigest === expected.planDigest &&
    current.snapshotKey === expected.snapshotKey &&
    current.connectionId === expected.connectionId &&
    current.connectionGeneration === expected.connectionGeneration &&
    current.plan.deploymentId === expected.plan.deploymentId
  );
}

async function requireSignedInUser(request: Request, env: Env): Promise<string> {
  const identity = await resolveAgentRequestIdentity(request, env);
  if (!identity?.userId) {
    throw new DeploymentAuthenticationError();
  }
  return identity.userId;
}

class DeploymentAuthenticationError extends Error {}

async function readBoundedDeploymentFormData(request: Request): Promise<FormData> {
  const parts = await readMultipartBodyWithLimits(request, {
    label: 'Deployment request',
    maximumBytes: MAX_DEPLOYMENT_REQUEST_BYTES,
    fields: DEPLOYMENT_FORM_FIELDS,
  });
  const formData = new FormData();
  const snapshot = parts.get('snapshot');
  if (snapshot instanceof Blob) {
    formData.set('snapshot', snapshot);
  }
  return formData;
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
  if (error instanceof DeploymentAuthenticationError) {
    return Response.json({ error: 'Sign in to deploy to production.' }, { status: 401 });
  }
  if (error instanceof PayloadTooLargeError) {
    return Response.json({ error: 'Deployment request exceeds the 11 MiB request limit.' }, { status: 413 });
  }
  if (error instanceof InvalidJsonBodyError || error instanceof InvalidMultipartBodyError) {
    return Response.json({ error: 'Invalid deployment request.' }, { status: 400 });
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
