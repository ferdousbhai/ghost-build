import type { GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import { deployToolParameters } from 'ghostbuild-agent/tools/deploy';
import { npmInstallToolParameters, splitPackageSpecs } from 'ghostbuild-agent/tools/npmInstall';
import { validateProjectParameters } from 'ghostbuild-agent/tools/validateProject';
import { toolFailure, toolSuccess, type GhostbuildToolResult } from 'ghostbuild-agent/tool-result';
import { createOrReplayDeploymentPlanForUser } from '~/server-handlers/deployments';
import { runLookupDocs } from '~/lib/runtime/action-runner/lookup-docs';
import type { BuilderWorkspaceApi } from './builder-workspace-api';
import type { ServerOperationToolName } from './builder-workspace-types';
import type { BuilderValidationStage } from '~/lib/common/builder-validation-progress';

type BuilderOperationContext = {
  env: Env;
  userId: string;
  chatInitialId: string;
  agentName: string;
  onValidationStage?: (toolCallId: string, stage: BuilderValidationStage | null) => void;
};

export async function executeBuilderOperationTool(args: {
  context: BuilderOperationContext;
  workspace: BuilderWorkspaceApi;
  toolCallId: string;
  toolName: ServerOperationToolName;
  input: unknown;
  abortSignal?: AbortSignal;
}): Promise<GhostbuildToolResult> {
  switch (args.toolName) {
    case 'lookupDocs':
      return runLookupDocs(invocation(args));
    case 'npmInstall':
      return runDependencyInstall(args);
    case 'validateProject':
      return runValidation(args);
    case 'deploy':
      return runDeployment(args);
    default:
      throw new Error(`Unsupported server operation tool: ${String(args.toolName)}`);
  }
}

async function runDependencyInstall(
  args: Parameters<typeof executeBuilderOperationTool>[0],
): Promise<GhostbuildToolResult> {
  const input = npmInstallToolParameters.parse(args.input);
  const mode = input.mode ?? 'add';
  const packages = splitPackageSpecs(input.packages ?? '');
  args.abortSignal?.throwIfAborted();
  return args.workspace.installDependencies({
    toolCallId: args.toolCallId,
    input: args.input,
    mode,
    packages,
  });
}

async function runValidation(args: Parameters<typeof executeBuilderOperationTool>[0]): Promise<GhostbuildToolResult> {
  validateProjectParameters.parse(args.input);
  args.abortSignal?.throwIfAborted();
  args.context.onValidationStage?.(args.toolCallId, 'sandbox initialization');
  try {
    return await args.workspace.validate({ toolCallId: args.toolCallId, input: args.input });
  } finally {
    args.context.onValidationStage?.(args.toolCallId, null);
  }
}

async function runDeployment(args: Parameters<typeof executeBuilderOperationTool>[0]): Promise<GhostbuildToolResult> {
  const input = deployToolParameters.parse(args.input);
  const snapshot = await args.workspace.checkpoint();
  return args.workspace.executeToolOnce(
    args.toolCallId,
    args.toolName,
    {
      input: args.input,
      workspaceRevision: snapshot.workspaceRevision,
      snapshotRevision: snapshot.revision,
    },
    async () => {
      if (snapshot.revision !== input.validatedRevision) {
        return toolFailure('The durable project changed after validation. Run full validation again.', {
          state: 'validation-stale',
          validatedRevision: input.validatedRevision,
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
      const deploymentId = await deterministicDeploymentId(
        `${args.context.agentName}:${args.toolCallId}:${snapshot.revision}`,
      );
      const deployment = await createOrReplayDeploymentPlanForUser({
        env: args.context.env,
        userId: args.context.userId,
        chatId: args.context.chatInitialId,
        deploymentId,
        projectId: args.context.agentName,
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

function invocation(args: Parameters<typeof executeBuilderOperationTool>[0]): GhostbuildToolInvocation {
  return {
    toolCallId: args.toolCallId,
    toolName: args.toolName,
    args: args.input,
    state: 'call',
  };
}

async function deterministicDeploymentId(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`deployment:${value}`)));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes.subarray(0, 16)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
