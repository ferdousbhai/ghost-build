import type { GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import { deployToolParameters } from 'ghostbuild-agent/tools/deploy';
import { npmInstallToolParameters, splitPackageSpecs } from 'ghostbuild-agent/tools/npmInstall';
import { validateProjectParameters } from 'ghostbuild-agent/tools/validateProject';
import { toolFailure, toolSuccess, type GhostbuildToolResult } from 'ghostbuild-agent/tool-result';
import {
  deterministicDeploymentId,
  installBuilderDependencies,
  validateBuilderProject,
} from '~/lib/.server/cloudflare/builder-project-sandbox';
import { createOrReplayDeploymentPlanForUser } from '~/server-handlers/deployments';
import { addRequestedDependencies, findPackagesNeedingInstall } from '~/lib/runtime/action-runner/dependency-manifest';
import { runLookupDocs } from '~/lib/runtime/action-runner/lookup-docs';
import { createBuilderWorkspaceSnapshot } from './builder-workspace-snapshot';
import { BuilderWorkspaceConflictError, type BuilderWorkspaceRepository } from './builder-workspace';
import type { ServerOperationToolName } from './builder-workspace-types';

type BuilderOperationContext = {
  env: Env;
  userId: string;
  chatInitialId: string;
  agentName: string;
};

export async function executeBuilderOperationTool(args: {
  context: BuilderOperationContext;
  workspace: BuilderWorkspaceRepository;
  toolCallId: string;
  toolName: ServerOperationToolName;
  input: unknown;
  abortSignal?: AbortSignal;
}): Promise<GhostbuildToolResult> {
  switch (args.toolName) {
    case 'lookupDocs':
      return args.workspace.executeToolOnce(args.toolCallId, args.toolName, args.input, () =>
        runLookupDocs(invocation(args)),
      );
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
  const packageFile = await args.workspace.readText('/home/project/package.json');
  const packageJson = packageFile.content;
  const packagesNeedingInstall = mode === 'sync-lockfile' ? [] : findPackagesNeedingInstall(packageJson, packages);
  const snapshot = await createBuilderWorkspaceSnapshot(args.workspace);
  if ((await args.workspace.readText('/home/project/package.json')).sha256 !== packageFile.sha256) {
    throw new BuilderWorkspaceConflictError(args.workspace.getState());
  }
  if (mode === 'add' && packagesNeedingInstall.length === 0) {
    return args.workspace.executeToolOnce(
      args.toolCallId,
      args.toolName,
      {
        input: args.input,
        workspaceRevision: snapshot.workspaceRevision,
        snapshotRevision: snapshot.revision,
      },
      async () =>
        toolSuccess(`Installed ${packages.length} dependency package${packages.length === 1 ? '' : 's'}.`, {
          mode,
          changedPaths: [],
          workspaceRevision: snapshot.workspaceRevision,
        }),
    );
  }
  const requestedPackageJson =
    mode === 'sync-lockfile' ? packageJson : addRequestedDependencies(packageJson, packagesNeedingInstall);
  let durationMs = 0;
  return args.workspace.commitTextFilesTool({
    toolCallId: args.toolCallId,
    toolName: 'npmInstall',
    toolArgs: {
      input: args.input,
      workspaceRevision: snapshot.workspaceRevision,
      snapshotRevision: snapshot.revision,
    },
    expectedWorkspaceRevision: snapshot.workspaceRevision,
    prepare: async () => {
      args.abortSignal?.throwIfAborted();
      const installed = await installBuilderDependencies({
        env: args.context.env,
        operationId: `${args.context.agentName}:${args.toolCallId}`,
        snapshot: snapshot.bytes,
        packageJson: requestedPackageJson,
      });
      durationMs = installed.durationMs;
      return [
        { path: '/home/project/package.json', content: installed.packageJson },
        { path: '/home/project/pnpm-lock.yaml', content: installed.pnpmLock },
      ];
    },
    result: ({ changedPaths, workspaceRevision }) =>
      toolSuccess(
        mode === 'sync-lockfile'
          ? 'Synchronized the durable project lockfile with package.json in the isolated dependency sandbox.'
          : `Installed ${packages.length} dependency package${packages.length === 1 ? '' : 's'} in the durable project.`,
        {
          mode,
          changedPaths,
          workspaceRevision,
          buildEnvironment: 'remote-sandbox',
          durationMs,
        },
      ),
  });
}

async function runValidation(args: Parameters<typeof executeBuilderOperationTool>[0]): Promise<GhostbuildToolResult> {
  validateProjectParameters.parse(args.input);
  const snapshot = await createBuilderWorkspaceSnapshot(args.workspace);
  return args.workspace.executeToolOnce(
    args.toolCallId,
    args.toolName,
    {
      input: args.input,
      workspaceRevision: snapshot.workspaceRevision,
      snapshotRevision: snapshot.revision,
    },
    async () => {
      args.abortSignal?.throwIfAborted();
      try {
        const validation = await validateBuilderProject({
          env: args.context.env,
          operationId: `${args.context.agentName}:${args.toolCallId}:${snapshot.revision}`,
          snapshot: snapshot.bytes,
        });
        args.workspace.recordSuccessfulValidation({
          revision: snapshot.revision,
          workspaceRevision: snapshot.workspaceRevision,
        });
        return toolSuccess(`Project validation passed at durable workspace revision ${snapshot.revision}.`, {
          level: 'full',
          revision: snapshot.revision,
          workspaceRevision: snapshot.workspaceRevision,
          buildEnvironment: 'remote-sandbox',
          checks: [
            'workspace-policy',
            'dependency-installation',
            'typecheck',
            'stack-verification',
            'build',
            'lint',
            'security-boundary',
          ].map((name) => ({ name, status: 'passed' as const })),
          durationMs: validation.durationMs,
          nextAction: 'prepare-deployment',
        });
      } catch (error) {
        args.abortSignal?.throwIfAborted();
        const current = args.workspace.getState();
        const workspaceChanged = current.revision !== snapshot.workspaceRevision;
        return toolFailure(
          workspaceChanged
            ? 'The durable project changed while validation was running. Validate the new revision.'
            : boundedError(error, 'The isolated project validation failed.'),
          {
            level: 'full',
            revision: snapshot.revision,
            workspaceRevision: snapshot.workspaceRevision,
            currentWorkspaceRevision: current.revision,
            buildEnvironment: 'remote-sandbox',
            checks: [
              {
                name: workspaceChanged ? 'workspace-stability' : 'production-build',
                status: 'failed' as const,
              },
            ],
          },
        );
      }
    },
  );
}

async function runDeployment(args: Parameters<typeof executeBuilderOperationTool>[0]): Promise<GhostbuildToolResult> {
  const input = deployToolParameters.parse(args.input);
  const snapshot = await createBuilderWorkspaceSnapshot(args.workspace);
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
      if (!args.workspace.hasSuccessfulValidation(snapshot.revision)) {
        return toolFailure('Deployment requires a successful durable full validation for this exact revision.', {
          state: 'validation-required',
          currentRevision: snapshot.revision,
        });
      }
      args.abortSignal?.throwIfAborted();
      const deploymentId = await deterministicDeploymentId(
        `${args.context.agentName}:${args.toolCallId}:${snapshot.revision}`,
      );
      const deployment = await createOrReplayDeploymentPlanForUser({
        env: args.context.env,
        userId: args.context.userId,
        chatId: args.context.chatInitialId,
        deploymentId,
        snapshot: new Blob([snapshot.bytes], { type: 'application/zip' }),
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

function boundedError(error: unknown, fallback: string): string {
  if (error instanceof BuilderWorkspaceConflictError) {
    return error.message;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 4_000 ? message : fallback;
}
