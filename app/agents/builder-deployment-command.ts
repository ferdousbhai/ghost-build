import { createOrReplayDeploymentPlanForUser, deployForUser } from '~/server-handlers/deployments';
import type { BuilderWorkspaceApi, BuilderWorkspaceCheckpoint } from './builder-workspace-api';

type BuilderDeploymentContext = {
  env: Env;
  userId: string;
  chatInitialId: string;
};

export type BuilderDeploymentState = {
  status: 'ready' | 'deploying' | 'succeeded' | 'failed';
  workspaceRevision?: number;
  revision?: string;
  id?: string;
  productionUrl?: string | null;
  error?: string | null;
};

export async function validatedDeploymentCheckpoint(
  workspace: BuilderWorkspaceApi,
): Promise<BuilderWorkspaceCheckpoint | null> {
  const snapshot = await workspace.checkpoint();
  return (await workspace.hasSuccessfulValidation(snapshot.revision)) ? snapshot : null;
}

/** Deploy the exact durably validated revision as one idempotent server operation. */
export async function deployValidatedRevisionForBuilder(args: {
  context: BuilderDeploymentContext;
  workspace: BuilderWorkspaceApi;
  toolCallId: string;
  validatedRevision: string;
  abortSignal?: AbortSignal;
}): Promise<BuilderDeploymentState> {
  const snapshot = await args.workspace.checkpoint();
  const operationId = `deployment:${args.workspace.projectId}:${args.toolCallId}`;
  if (snapshot.revision !== args.validatedRevision) {
    throw new Error('The durable project changed after validation. Run validation again.');
  }
  if (!(await args.workspace.hasSuccessfulValidation(snapshot.revision))) {
    throw new Error('Deployment requires full validation for this exact revision.');
  }
  args.abortSignal?.throwIfAborted();
  const source = await args.workspace.prepareDeployment(snapshot.revision);
  const deploymentId = await deterministicDeploymentId(`${operationId}:${snapshot.revision}`);
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

async function deterministicDeploymentId(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`deployment:${value}`)));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes.subarray(0, 16)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
