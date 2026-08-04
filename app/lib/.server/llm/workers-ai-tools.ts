import { getToolInvocation, type GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { deployTool } from 'ghostbuild-agent/tools/deploy';
import { lookupDocsTool } from 'ghostbuild-agent/tools/lookupDocs';
import { npmInstallTool } from 'ghostbuild-agent/tools/npmInstall';
import { validateProjectTool } from 'ghostbuild-agent/tools/validateProject';
import { createAITools } from '@cloudflare/computer/tools';
import type { GhostbuildToolName, GhostbuildToolSet } from 'ghostbuild-agent/types';
import { z, type ZodType } from 'zod';
import { isGhostbuildToolResult, toolFailure, toolResultSucceeded } from 'ghostbuild-agent/tool-result';
import type { Tool } from 'ai';
import type { BuilderWorkspaceApi } from '~/agents/builder-workspace-api';
import type { ServerWorkspaceToolName } from '~/agents/builder-workspace-types';
import type { ServerOperationToolName } from '~/agents/builder-workspace-types';
import type { BuilderValidationStage } from '~/lib/common/builder-validation-progress';

type BuilderOperationContext = {
  env: Env;
  userId: string;
  chatInitialId: string;
  agentName: string;
  onValidationStage?: (toolCallId: string, stage: BuilderValidationStage | null) => void;
};

export type AgentToolChoice = 'auto' | 'none' | 'required';
type AgentToolSettings = {
  activeTools?: GhostbuildToolName[];
  toolChoice: AgentToolChoice;
};
type ToolResultEvent = {
  toolName: string;
  result: unknown;
};
type TurnToolCallGuard = (
  toolName: GhostbuildToolName,
  input: unknown,
  toolCallId: string,
  workspaceRevision: number,
) => string | undefined;
type TurnStatefulToolCoordinator = <T>(toolName: GhostbuildToolName, operation: () => Promise<T>) => Promise<T>;
type BuildLifecycle =
  | { stage: 'needs-implementation' }
  | { stage: 'needs-validation' }
  | { stage: 'validation-failed' }
  | { stage: 'guest-validated' }
  | { stage: 'needs-deploy' }
  | { stage: 'deploy-failed' }
  | { stage: 'deployment-ready'; production: boolean };

const AUTOMATIC_TOOLS: GhostbuildToolName[] = [
  'read',
  'ls',
  'edit',
  'write',
  'exec',
  'lookupDocs',
  'npmInstall',
  'validateProject',
];
const IMPLEMENTATION_TOOLS = AUTOMATIC_TOOLS.filter((toolName) => toolName !== 'validateProject');

export function createWorkersAiTools(
  workspace: BuilderWorkspaceApi,
  operationContext: BuilderOperationContext,
): GhostbuildToolSet {
  const guardToolCall = createTurnToolCallGuard();
  const coordinateStatefulTool = createTurnStatefulToolCoordinator();
  const computerTools = createAITools({
    workspace: workspace.computer,
    shell: {
      backends: {
        'worker-shell': {
          description: 'Fast isolated shell for common text, file, and JavaScript commands.',
        },
        'container-shell': {
          description: 'Full Linux environment with Node.js, pnpm, git, Wrangler, network access, and build tools.',
        },
      },
      defaultBackend: 'worker-shell',
    },
  });
  const tools: GhostbuildToolSet = {
    deploy: deployTool,
    edit: computerTools.edit!,
    exec: computerTools.exec!,
    ls: computerTools.ls!,
    lookupDocs: lookupDocsTool(),
    npmInstall: npmInstallTool,
    read: computerTools.read!,
    validateProject: validateProjectTool,
    write: computerTools.write!,
  };
  for (const toolName of ['read', 'ls', 'write', 'edit', 'exec'] as const) {
    tools[toolName] = computerWorkspaceTool(
      toolName,
      tools[toolName],
      workspace,
      guardToolCall,
      coordinateStatefulTool,
    );
  }
  for (const toolName of ['lookupDocs', 'npmInstall', 'validateProject', 'deploy'] as const) {
    tools[toolName] = serverOperationTool(
      toolName,
      tools[toolName],
      workspace,
      operationContext,
      guardToolCall,
      coordinateStatefulTool,
    );
  }
  return tools;
}

function serverOperationTool(
  toolName: ServerOperationToolName,
  definition: Tool,
  workspace: BuilderWorkspaceApi,
  context: BuilderOperationContext,
  guardToolCall: TurnToolCallGuard,
  coordinateStatefulTool: TurnStatefulToolCoordinator,
): Tool {
  return {
    ...definition,
    execute: async (input, options) =>
      coordinateStatefulTool(toolName, async () => {
        const duplicate = guardToolCall(toolName, input, options.toolCallId, workspace.getState().revision);
        if (duplicate) {
          return toolFailure(duplicate);
        }
        try {
          const { executeBuilderOperationTool } = await import('~/agents/builder-operation-tools');
          return await executeBuilderOperationTool({
            context,
            workspace,
            toolCallId: options.toolCallId,
            toolName,
            input,
            abortSignal: options.abortSignal,
          });
        } catch (error) {
          options.abortSignal?.throwIfAborted();
          const message = error instanceof Error ? error.message : String(error);
          return toolFailure(
            message.length <= 4_000
              ? message
              : `${toolName} failed with an unusually large internal error retained in server logs.`,
          );
        }
      }),
  };
}

function computerWorkspaceTool(
  toolName: ServerWorkspaceToolName,
  definition: Tool,
  workspace: BuilderWorkspaceApi,
  guardToolCall: TurnToolCallGuard,
  coordinateStatefulTool: TurnStatefulToolCoordinator,
): Tool {
  return {
    ...definition,
    execute: async (input, options) =>
      coordinateStatefulTool(toolName, async () => {
        const duplicate = guardToolCall(toolName, input, options.toolCallId, workspace.getState().revision);
        if (duplicate) {
          return toolFailure(duplicate);
        }
        try {
          if (!definition.execute) {
            throw new Error(`${toolName} is not executable.`);
          }
          const result = await workspace.executeToolOnce(options.toolCallId, toolName, input, async () => {
            const revisionBefore = workspace.getState().revision;
            const officialResult = await definition.execute!(input, options);
            if (toolName !== 'exec') {
              return officialResult;
            }
            await workspace.refresh();
            return isRecord(officialResult)
              ? { ...officialResult, workspaceChanged: workspace.getState().revision !== revisionBefore }
              : officialResult;
          });
          if (toolName === 'write' || toolName === 'edit') {
            await workspace.refresh();
          }
          return result;
        } catch (error) {
          options.abortSignal?.throwIfAborted();
          const message = error instanceof Error ? error.message : String(error);
          return toolFailure(
            message.length <= 4_000
              ? message
              : `${toolName} failed with an unusually large internal error retained in server logs.`,
          );
        }
      }),
  };
}

export function createTurnToolCallGuard(): TurnToolCallGuard {
  const toolCallIds = new Map<string, string>();
  return (toolName, input, toolCallId, workspaceRevision) => {
    const key = `${workspaceRevision}:${toolName}:${stableJson(input)}`;
    const previousToolCallId = toolCallIds.get(key);
    if (!previousToolCallId) {
      toolCallIds.set(key, toolCallId);
      return undefined;
    }
    if (previousToolCallId === toolCallId) {
      return undefined;
    }
    return 'This exact tool call already ran in the current turn. Use its result or try a different approach.';
  };
}

export function createTurnStatefulToolCoordinator(): TurnStatefulToolCoordinator {
  let tail = Promise.resolve();
  return (toolName, operation) => {
    if (!isStatefulTool(toolName)) {
      return operation();
    }
    const scheduled = tail.then(operation, operation);
    tail = scheduled.then(
      () => undefined,
      () => undefined,
    );
    return scheduled;
  };
}

function isStatefulTool(toolName: GhostbuildToolName): boolean {
  return (
    toolName === 'edit' ||
    toolName === 'write' ||
    toolName === 'exec' ||
    toolName === 'npmInstall' ||
    toolName === 'validateProject' ||
    toolName === 'deploy'
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])]),
  );
}

export function serializeWorkersAiToolDefinitions(
  tools: GhostbuildToolSet,
  activeTools?: GhostbuildToolName[],
): string {
  const activeToolNames = activeTools ? new Set(activeTools) : null;
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(tools)
        .filter(([name]) => !activeToolNames || activeToolNames.has(name as GhostbuildToolName))
        .map(([name, tool]) => [
          name,
          {
            description: tool.description,
            inputSchema: z.toJSONSchema(tool.inputSchema as ZodType),
          },
        ]),
    ),
  );
}

export function getWorkersAiToolSettings(
  messages: GhostbuildMessage[],
  currentStepResults: ReadonlyArray<ToolResultEvent> = [],
): AgentToolSettings {
  const lastUserIndex = messages.findLastIndex((message) => message.role === 'user');
  const toolResults = collectToolResults(messages);
  const currentTurnResults = [
    ...toolResults.filter(({ messageIndex }) => messageIndex > lastUserIndex),
    ...currentStepResults,
  ];
  const currentTurnLifecycle = analyzeBuildLifecycle(currentTurnResults);
  if (currentTurnLifecycle) {
    return currentTurnLifecycleToolSettings(currentTurnLifecycle);
  }

  const priorLifecycle = analyzeBuildLifecycle([...toolResults, ...currentStepResults]);
  if (priorLifecycle) {
    const priorSettings = lifecycleToolSettings(priorLifecycle);
    if (priorSettings.toolChoice !== 'none') {
      return priorSettings;
    }
  }

  return automaticToolSettings();
}

function currentTurnLifecycleToolSettings(lifecycle: BuildLifecycle): AgentToolSettings {
  switch (lifecycle.stage) {
    case 'needs-implementation':
      return {
        activeTools: [...IMPLEMENTATION_TOOLS],
        toolChoice: 'required',
      };
    case 'needs-validation':
    case 'validation-failed':
      return {
        activeTools: [...AUTOMATIC_TOOLS],
        toolChoice: 'required',
      };
    case 'deploy-failed':
      return {
        activeTools: [...AUTOMATIC_TOOLS, 'deploy'],
        toolChoice: 'required',
      };
    default:
      return lifecycleToolSettings(lifecycle);
  }
}

function analyzeBuildLifecycle(toolResults: ReadonlyArray<ToolResultEvent>): BuildLifecycle | undefined {
  const implementationIndex = toolResults.findLastIndex(isImplementationMutationResult);
  const dependencyIndex = toolResults.findLastIndex(isDependencyMutationResult);
  if (implementationIndex === -1 && dependencyIndex === -1) {
    return undefined;
  }
  if (implementationIndex === -1) {
    return { stage: 'needs-implementation' };
  }
  const mutationIndex = Math.max(implementationIndex, dependencyIndex);
  const lastValidationIndex = toolResults.findLastIndex(
    ({ toolName }, index) => toolName === 'validateProject' && index > mutationIndex,
  );
  if (lastValidationIndex === -1) {
    return { stage: 'needs-validation' };
  }
  const validationResult = toolResults[lastValidationIndex].result;
  if (!isSuccessfulValidationResult(validationResult)) {
    return { stage: 'validation-failed' };
  }
  if (validationNextAction(validationResult) === 'sign-in-required') {
    return { stage: 'guest-validated' };
  }
  const lastDeployIndex = toolResults.findLastIndex(
    ({ toolName }, index) => toolName === 'deploy' && index > lastValidationIndex,
  );
  if (lastDeployIndex === -1) {
    return { stage: 'needs-deploy' };
  }
  const deployResult = toolResults[lastDeployIndex].result;
  if (isProductionDeployResult(deployResult)) {
    return { stage: 'deployment-ready', production: true };
  }
  if (isSuccessfulDeployResult(deployResult, validationRevision(validationResult))) {
    return { stage: 'deployment-ready', production: false };
  }
  return { stage: 'deploy-failed' };
}

function lifecycleToolSettings(lifecycle: BuildLifecycle): AgentToolSettings {
  switch (lifecycle.stage) {
    case 'needs-implementation':
      return {
        activeTools: [...IMPLEMENTATION_TOOLS],
        toolChoice: 'required',
      };
    case 'needs-validation':
      return requiredToolSettings('validateProject');
    case 'validation-failed':
      return automaticToolSettings();
    case 'guest-validated':
    case 'deployment-ready':
      return { toolChoice: 'none' };
    case 'needs-deploy':
      return requiredToolSettings('deploy');
    case 'deploy-failed':
      return {
        activeTools: [...AUTOMATIC_TOOLS, 'deploy'],
        toolChoice: 'auto',
      };
    default: {
      const unsupported: never = lifecycle;
      throw new Error(`Unsupported build lifecycle: ${JSON.stringify(unsupported)}`);
    }
  }
}

function automaticToolSettings(): AgentToolSettings {
  return {
    activeTools: [...AUTOMATIC_TOOLS],
    toolChoice: 'auto',
  };
}

function requiredToolSettings(toolName: GhostbuildToolName): AgentToolSettings {
  return {
    activeTools: [toolName],
    toolChoice: 'required',
  };
}

export function getValidatedBuildCompletion(
  messages: GhostbuildMessage[],
  currentStepResults: ReadonlyArray<ToolResultEvent> = [],
): string | undefined {
  const lastUserIndex = messages.findLastIndex((message) => message.role === 'user');
  if (lastUserIndex === -1) {
    return undefined;
  }

  const lifecycle = analyzeBuildLifecycle([
    ...collectToolResults(messages).filter(({ messageIndex }) => messageIndex > lastUserIndex),
    ...currentStepResults,
  ]);
  if (lifecycle?.stage === 'guest-validated') {
    return 'Done. I built and validated the app in the isolated production build environment, and it is ready to preview here. Sign in when you are ready to deploy it to Cloudflare production.';
  }
  if (lifecycle?.stage !== 'deployment-ready') {
    return undefined;
  }
  return lifecycle.production
    ? 'Done. I built, validated, and deployed the app to Cloudflare production.'
    : 'Done. I built and validated the app. The production deployment plan is ready for your approval.';
}

function collectToolResults(messages: GhostbuildMessage[]): Array<{
  messageIndex: number;
  toolName: string;
  result: unknown;
}> {
  return messages.flatMap((message, messageIndex) =>
    message.parts.flatMap((part) => {
      const invocation = getToolInvocation(part);
      if (invocation?.state !== 'result') {
        return [];
      }
      return [
        {
          messageIndex,
          toolName: invocation.toolName,
          result: invocation.result,
        },
      ];
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isImplementationMutationResult(result: { toolName: string; result?: unknown }): boolean {
  if (!isRecord(result.result) || typeof result.result.error === 'string') {
    return false;
  }
  return (
    (result.toolName === 'write' && typeof result.result.bytesWritten === 'number') ||
    (result.toolName === 'edit' && typeof result.result.editsApplied === 'number') ||
    (result.toolName === 'exec' && result.result.exitCode === 0 && result.result.workspaceChanged === true)
  );
}

function isDependencyMutationResult(result: { toolName: string; result?: unknown }): boolean {
  return result.toolName === 'npmInstall' && toolResultSucceeded(result.result);
}

function isSuccessfulValidationResult(result: unknown): boolean {
  return (
    isGhostbuildToolResult(result) &&
    result.ok &&
    isRecord(result.data) &&
    result.data.level === 'full' &&
    validationRevision(result) !== undefined &&
    validationNextAction(result) !== undefined
  );
}

function validationRevision(result: unknown): string | undefined {
  if (!isGhostbuildToolResult(result) || !isRecord(result.data)) {
    return undefined;
  }
  return typeof result.data.revision === 'string' ? result.data.revision : undefined;
}

function validationNextAction(result: unknown): 'sign-in-required' | 'prepare-deployment' | undefined {
  if (!isGhostbuildToolResult(result) || !isRecord(result.data)) {
    return undefined;
  }
  const nextAction = result.data.nextAction;
  return nextAction === 'sign-in-required' || nextAction === 'prepare-deployment' ? nextAction : undefined;
}

function isSuccessfulDeployResult(result: unknown, expectedRevision?: string): boolean {
  if (isGhostbuildToolResult(result)) {
    return (
      result.ok &&
      isRecord(result.data) &&
      result.data.state === 'awaiting-approval' &&
      (expectedRevision === undefined || result.data.revision === expectedRevision)
    );
  }
  return (
    typeof result === 'string' &&
    (result.includes('Deployment plan ready for your approval') || isProductionDeployResult(result))
  );
}

function isProductionDeployResult(result: unknown): boolean {
  if (isGhostbuildToolResult(result)) {
    return result.ok && isRecord(result.data) && result.data.state === 'deployed';
  }
  return (
    typeof result === 'string' && (result.includes('Uploaded ghostbuild') || result.includes('Deployed ghostbuild'))
  );
}
