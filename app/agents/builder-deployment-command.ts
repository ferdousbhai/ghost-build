import {
  createOrReplayDeploymentPlanForUser,
  deployForUser,
  previewForUser,
  terminalizeInterruptedDeploymentForUser,
} from '~/server-handlers/deployments';
import type { BuilderWorkspaceApi, BuilderWorkspaceCheckpoint } from './builder-workspace-api';

type BuilderDeploymentContext = {
  env: Env;
  userId: string;
  chatInitialId: string;
};

type BuilderDeploymentWorkspace = Pick<
  BuilderWorkspaceApi,
  'projectId' | 'checkpoint' | 'hasSuccessfulValidation' | 'prepareDeployment'
>;

export type BuilderDeploymentState = {
  status: 'ready' | 'deploying' | 'succeeded' | 'failed';
  workspaceRevision?: number;
  revision?: string;
  id?: string;
  productionUrl?: string | null;
  error?: string | null;
};

export async function validatedDeploymentCheckpoint(
  workspace: Pick<BuilderWorkspaceApi, 'checkpoint' | 'hasSuccessfulValidation'>,
): Promise<BuilderWorkspaceCheckpoint | null> {
  const snapshot = await workspace.checkpoint();
  return (await workspace.hasSuccessfulValidation(snapshot.revision)) ? snapshot : null;
}

export async function terminalizeInterruptedDeploymentForBuilder(args: {
  context: BuilderDeploymentContext;
  workspace: Pick<BuilderWorkspaceApi, 'projectId'>;
  toolCallId: string;
  validatedRevision: string;
}): Promise<BuilderDeploymentState> {
  const deploymentId = await publicationDeploymentId(args.workspace.projectId, args.toolCallId, args.validatedRevision);
  const deployment = await terminalizeInterruptedDeploymentForUser({
    env: args.context.env,
    userId: args.context.userId,
    deploymentId,
  });
  return deployment
    ? {
        id: deployment.id,
        status:
          deployment.status === 'succeeded' ? 'succeeded' : deployment.status === 'failed' ? 'failed' : 'deploying',
        productionUrl: deployment.productionUrl,
        error: deployment.error?.message ?? null,
      }
    : {
        status: 'failed',
        error: 'Deployment was interrupted before execution started.',
      };
}

/** Deploy the exact durably validated revision as one idempotent server operation. */
export async function deployValidatedRevisionForBuilder(args: {
  context: BuilderDeploymentContext;
  workspace: BuilderDeploymentWorkspace;
  toolCallId: string;
  validatedRevision: string;
  abortSignal?: AbortSignal;
}): Promise<BuilderDeploymentState> {
  const deploymentId = await planValidatedRevision({ ...args, publication: 'Deployment' });
  const deployment = await deployForUser({
    env: args.context.env,
    userId: args.context.userId,
    deploymentId,
  });
  return {
    id: deployment.id,
    status: deployment.status === 'succeeded' ? 'succeeded' : 'deploying',
    productionUrl: deployment.productionUrl,
    error: deployment.error?.message ?? null,
  };
}

/**
 * Preview the same validated revision under the same deployment plan. Passing the deployment's own
 * tool-call identity is what makes the preview an unpromoted version of that exact deployment
 * rather than a second publication with resources of its own.
 */
export async function previewValidatedRevisionForBuilder(args: {
  context: BuilderDeploymentContext;
  workspace: BuilderDeploymentWorkspace;
  toolCallId: string;
  previewId: string;
  validatedRevision: string;
}) {
  const deploymentId = await planValidatedRevision({ ...args, publication: 'Preview' });
  return previewForUser({
    env: args.context.env,
    userId: args.context.userId,
    deploymentId,
    previewId: args.previewId,
  });
}

/** Create or replay the one deployment plan for this exact revision and return its identity. */
async function planValidatedRevision(args: {
  context: BuilderDeploymentContext;
  workspace: BuilderDeploymentWorkspace;
  toolCallId: string;
  validatedRevision: string;
  publication: 'Deployment' | 'Preview';
  abortSignal?: AbortSignal;
}): Promise<string> {
  const snapshot = await args.workspace.checkpoint();
  if (snapshot.revision !== args.validatedRevision) {
    throw new Error('The durable project changed after validation. Run validation again.');
  }
  if (!(await args.workspace.hasSuccessfulValidation(snapshot.revision))) {
    throw new Error(`${args.publication} requires full validation for this exact revision.`);
  }
  args.abortSignal?.throwIfAborted();
  const source = await args.workspace.prepareDeployment(snapshot.revision);
  const deploymentId = await publicationDeploymentId(args.workspace.projectId, args.toolCallId, snapshot.revision);
  await createOrReplayDeploymentPlanForUser({
    env: args.context.env,
    userId: args.context.userId,
    chatId: args.context.chatInitialId,
    deploymentId,
    projectId: args.workspace.projectId,
    revision: source.revision,
    workspaceRevision: source.workspaceRevision,
    project: source.project,
  });
  return deploymentId;
}

function publicationDeploymentId(projectId: string, toolCallId: string, revision: string): Promise<string> {
  return deterministicDeploymentId(`deployment:${projectId}:${toolCallId}:${revision}`);
}

async function deterministicDeploymentId(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`deployment:${value}`)));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes.subarray(0, 16)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
