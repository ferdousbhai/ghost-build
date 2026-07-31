import { getToolInvocation, type GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { deployTool } from 'ghostbuild-agent/tools/deploy';
import { editTool } from 'ghostbuild-agent/tools/edit';
import { lookupDocsTool } from 'ghostbuild-agent/tools/lookupDocs';
import { npmInstallTool } from 'ghostbuild-agent/tools/npmInstall';
import { viewTool } from 'ghostbuild-agent/tools/view';
import { writeFileTool } from 'ghostbuild-agent/tools/writeFile';
import { listFilesTool } from 'ghostbuild-agent/tools/listFiles';
import { searchTextTool } from 'ghostbuild-agent/tools/searchText';
import { validateProjectTool } from 'ghostbuild-agent/tools/validateProject';
import type { GhostbuildToolName, GhostbuildToolSet } from 'ghostbuild-agent/types';
import { z, type ZodType } from 'zod';
import { isGhostbuildToolResult, toolFailure, toolResultSucceeded } from 'ghostbuild-agent/tool-result';
import type { Tool } from 'ai';
import type { BuilderWorkspaceRepository } from '~/agents/builder-workspace';
import { executeBuilderWorkspaceTool } from '~/agents/builder-workspace-tools';
import type { ServerWorkspaceToolName } from '~/agents/builder-workspace-types';
import type { ServerOperationToolName } from '~/agents/builder-workspace-types';

type BuilderOperationContext = {
  env: Env;
  userId: string;
  chatInitialId: string;
  agentName: string;
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
type BuildLifecycle =
  | { stage: 'needs-validation' }
  | { stage: 'validation-failed' }
  | { stage: 'guest-validated' }
  | { stage: 'needs-deploy' }
  | { stage: 'deploy-failed' }
  | { stage: 'deployment-ready'; production: boolean };

const AUTOMATIC_TOOLS: GhostbuildToolName[] = [
  'view',
  'listFiles',
  'searchText',
  'edit',
  'writeFile',
  'lookupDocs',
  'npmInstall',
  'validateProject',
];

export function createWorkersAiTools(
  workspace: BuilderWorkspaceRepository,
  operationContext: BuilderOperationContext,
): GhostbuildToolSet {
  const guardToolCall = createTurnToolCallGuard();
  const tools: GhostbuildToolSet = {
    deploy: deployTool,
    edit: editTool,
    listFiles: listFilesTool,
    lookupDocs: lookupDocsTool(),
    npmInstall: npmInstallTool,
    searchText: searchTextTool,
    validateProject: validateProjectTool,
    view: viewTool,
    writeFile: writeFileTool,
  };
  for (const toolName of ['view', 'listFiles', 'searchText', 'edit', 'writeFile'] as const) {
    tools[toolName] = serverWorkspaceTool(toolName, tools[toolName], workspace, guardToolCall);
  }
  for (const toolName of ['lookupDocs', 'npmInstall', 'validateProject', 'deploy'] as const) {
    tools[toolName] = serverOperationTool(toolName, tools[toolName], workspace, operationContext, guardToolCall);
  }
  return tools;
}

function serverOperationTool(
  toolName: ServerOperationToolName,
  definition: Tool,
  workspace: BuilderWorkspaceRepository,
  context: BuilderOperationContext,
  guardToolCall: TurnToolCallGuard,
): Tool {
  return {
    ...definition,
    execute: async (input, options) => {
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
    },
  };
}

function serverWorkspaceTool(
  toolName: ServerWorkspaceToolName,
  definition: Tool,
  workspace: BuilderWorkspaceRepository,
  guardToolCall: TurnToolCallGuard,
): Tool {
  return {
    ...definition,
    execute: async (input, options) => {
      const duplicate = guardToolCall(toolName, input, options.toolCallId, workspace.getState().revision);
      if (duplicate) {
        return toolFailure(duplicate);
      }
      try {
        return await executeBuilderWorkspaceTool({
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
    },
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
    return lifecycleToolSettings(currentTurnLifecycle);
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

function analyzeBuildLifecycle(toolResults: ReadonlyArray<ToolResultEvent>): BuildLifecycle | undefined {
  const mutationIndex = toolResults.findLastIndex(isMutationResult);
  if (mutationIndex === -1) {
    return undefined;
  }
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

export function getValidatedBuildCompletion(messages: GhostbuildMessage[]): string | undefined {
  const lastUserIndex = messages.findLastIndex((message) => message.role === 'user');
  if (lastUserIndex === -1) {
    return undefined;
  }

  const lifecycle = analyzeBuildLifecycle(
    collectToolResults(messages).filter(({ messageIndex }) => messageIndex > lastUserIndex),
  );
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

function isMutationResult(result: { toolName: string; result?: unknown }): boolean {
  return (result.toolName === 'writeFile' || result.toolName === 'edit') && toolResultSucceeded(result.result);
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
