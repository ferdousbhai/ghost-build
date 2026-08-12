import { toolFailure, toolSuccess, type GhostbuildToolResult } from 'ghostbuild-agent/tool-result';
import { createOrReplayDeploymentPlanForUser } from '~/server-handlers/deployments';
import type { BuilderWorkspaceApi, BuilderWorkspaceCheckpoint } from './builder-workspace-api';

type BuilderDeploymentContext = {
  env: Env;
  userId: string;
  chatInitialId: string;
  agentName: string;
};

export async function validatedDeploymentCheckpoint(
  workspace: BuilderWorkspaceApi,
): Promise<BuilderWorkspaceCheckpoint | null> {
  const snapshot = await workspace.checkpoint();
  return (await workspace.hasSuccessfulValidation(snapshot.revision)) ? snapshot : null;
}

/** Prepare an exact-revision deployment plan for the authenticated user command. */
export async function prepareDeploymentPlanForBuilder(args: {
  context: BuilderDeploymentContext;
  workspace: BuilderWorkspaceApi;
  toolCallId: string;
  validatedRevision: string;
  abortSignal?: AbortSignal;
}): Promise<GhostbuildToolResult> {
  const snapshot = await args.workspace.checkpoint();
  const operationId = `deployment-plan:${args.workspace.projectId}:${args.toolCallId}`;
  return args.workspace.executeToolOnce(
    operationId,
    'deploy',
    {
      validatedRevision: args.validatedRevision,
      workspaceRevision: snapshot.workspaceRevision,
      snapshotRevision: snapshot.revision,
    },
    async () => {
      if (snapshot.revision !== args.validatedRevision) {
        return toolFailure('The durable project changed after validation. Run validation again.', {
          state: 'validation-stale',
          validatedRevision: args.validatedRevision,
          currentRevision: snapshot.revision,
        });
      }
      if (!(await args.workspace.hasSuccessfulValidation(snapshot.revision))) {
        return toolFailure('Deployment requires a successful durable full validation for this exact revision.', {
          state: 'validation-required',
          currentRevision: snapshot.revision,
        });
      }
      args.abortSignal?.throwIfAborted();
      const deploymentSource = await args.workspace.prepareDeployment(snapshot.revision);
      const deploymentId = await deterministicDeploymentId(`${operationId}:${snapshot.revision}`);
      const deployment = await createOrReplayDeploymentPlanForUser({
        env: args.context.env,
        userId: args.context.userId,
        chatId: args.context.chatInitialId,
        deploymentId,
        projectId: args.workspace.projectId,
        revision: deploymentSource.revision,
        workspaceRevision: deploymentSource.workspaceRevision,
        project: deploymentSource.project,
      });
      return toolSuccess(
        'Deployment plan ready for explicit approval. Production will rebuild this exact validated revision.',
        {
          state: 'awaiting-approval',
          revision: snapshot.revision,
          deployment: {
            id: deployment.id,
            planDigest: deployment.planDigest,
            resources: deployment.plan.resources,
          },
        },
      );
    },
  );
}

async function deterministicDeploymentId(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`deployment:${value}`)));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes.subarray(0, 16)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
