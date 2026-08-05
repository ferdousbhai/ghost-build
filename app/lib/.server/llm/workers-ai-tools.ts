import { getToolInvocation, type GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { deployTool } from 'ghostbuild-agent/tools/deploy';
import { lookupDocsTool } from 'ghostbuild-agent/tools/lookupDocs';
import { npmInstallTool } from 'ghostbuild-agent/tools/npmInstall';
import { validateProjectTool } from 'ghostbuild-agent/tools/validateProject';
import {
  COMPUTER_AI_TOOL_OPTIONS,
  COMPUTER_EXEC_APPLICATION_POLICY,
  COMPUTER_TOOL_NAMES,
  computerSyncUnconfirmedToolResult,
  type ComputerToolName,
} from 'ghostbuild-agent/cloudflare-computer';
import { createAITools } from '@cloudflare/computer/tools';
import type { GhostbuildToolName, GhostbuildToolSet } from 'ghostbuild-agent/types';
import { z, type ZodType } from 'zod';
import { isGhostbuildToolResult, toolFailure } from 'ghostbuild-agent/tool-result';
import type { Tool, ToolSet } from 'ai';
import type { BuilderWorkspaceApi } from '~/agents/builder-workspace-api';
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
type TurnStatefulToolCoordinator = <T>(toolName: GhostbuildToolName, operation: () => Promise<T>) => Promise<T>;
type BuildLifecycle =
  | { stage: 'needs-implementation' }
  | { stage: 'needs-validation' }
  | { stage: 'validation-failed' }
  | { stage: 'guest-validated' }
  | { stage: 'needs-deploy' }
  | { stage: 'deploy-failed' }
  | { stage: 'deployment-ready'; production: boolean };

const AUTOMATIC_TOOLS: GhostbuildToolName[] = [...COMPUTER_TOOL_NAMES, 'lookupDocs', 'npmInstall', 'validateProject'];
const IMPLEMENTATION_TOOLS = AUTOMATIC_TOOLS.filter((toolName) => toolName !== 'validateProject');

export function createWorkersAiTools(
  workspace: BuilderWorkspaceApi,
  operationContext: BuilderOperationContext,
): GhostbuildToolSet {
  const coordinateStatefulTool = createTurnStatefulToolCoordinator();
  const computerTools = requireComputerTools(
    createAITools({
      workspace: workspace.computer,
      ...COMPUTER_AI_TOOL_OPTIONS,
    }),
  );
  const tools: GhostbuildToolSet = {
    ...computerTools,
    deploy: deployTool,
    lookupDocs: lookupDocsTool(),
    npmInstall: npmInstallTool,
    validateProject: validateProjectTool,
  };
  for (const toolName of COMPUTER_TOOL_NAMES) {
    tools[toolName] = computerWorkspaceTool(toolName, tools[toolName], workspace, coordinateStatefulTool);
  }
  for (const toolName of ['lookupDocs', 'npmInstall', 'validateProject', 'deploy'] as const) {
    tools[toolName] = serverOperationTool(
      toolName,
      tools[toolName],
      workspace,
      operationContext,
      coordinateStatefulTool,
    );
  }
  return tools;
}

function requireComputerTools(tools: ToolSet): Record<ComputerToolName, Tool> {
  return Object.fromEntries(
    COMPUTER_TOOL_NAMES.map((toolName) => {
      const definition = tools[toolName];
      if (!definition) {
        throw new Error(`Cloudflare Computer did not expose the required ${toolName} tool.`);
      }
      return [toolName, definition];
    }),
  ) as Record<ComputerToolName, Tool>;
}

function serverOperationTool(
  toolName: ServerOperationToolName,
  definition: Tool,
  workspace: BuilderWorkspaceApi,
  context: BuilderOperationContext,
  coordinateStatefulTool: TurnStatefulToolCoordinator,
): Tool {
  return {
    ...definition,
    execute: async (input, options) => {
      options.abortSignal?.throwIfAborted();
      return coordinateStatefulTool(toolName, async () => {
        options.abortSignal?.throwIfAborted();
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
          const syncResult = computerSyncUnconfirmedToolResult(error);
          if (syncResult) {
            return syncResult;
          }
          const message = error instanceof Error ? error.message : String(error);
          return toolFailure(
            message.length <= 4_000
              ? message
              : `${toolName} failed; its unusually large internal error was omitted from the model response.`,
          );
        }
      });
    },
  };
}

function computerWorkspaceTool(
  toolName: ComputerToolName,
  definition: Tool,
  workspace: BuilderWorkspaceApi,
  coordinateStatefulTool: TurnStatefulToolCoordinator,
): Tool {
  if (definition.type === 'provider') {
    throw new TypeError(`Computer tool ${toolName} must be executed by Ghostbuild, not by the model provider.`);
  }
  return {
    ...definition,
    description:
      toolName === 'exec'
        ? `Run a shell command in the project workspace using its Cloudflare Container.\n\n${COMPUTER_EXEC_APPLICATION_POLICY}`
        : definition.description,
    execute: async (input, options) => {
      options.abortSignal?.throwIfAborted();
      return coordinateStatefulTool(toolName, async () => {
        options.abortSignal?.throwIfAborted();
        try {
          const execute = definition.execute;
          if (!execute) {
            throw new Error(`${toolName} is not executable.`);
          }
          const result =
            toolName === 'read' || toolName === 'ls'
              ? await execute(input, options)
              : await workspace.executeToolOnce(options.toolCallId, toolName, input, () => execute(input, options));
          if (toolName === 'exec') {
            await workspace.refresh();
          }
          return result;
        } catch (error) {
          options.abortSignal?.throwIfAborted();
          const syncResult = computerSyncUnconfirmedToolResult(error);
          if (syncResult) {
            return syncResult;
          }
          const message = error instanceof Error ? error.message : String(error);
          return {
            error:
              message.length <= 4_000
                ? message
                : `${toolName} failed; its unusually large internal error was omitted from the model response.`,
          };
        }
      });
    },
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
      if (invocation?.state !== 'output-available') {
        return [];
      }
      return [
        {
          messageIndex,
          toolName: invocation.toolName,
          result: invocation.output,
        },
      ];
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isImplementationMutationResult(result: { toolName: string; result?: unknown }): boolean {
  if (result.toolName === 'exec') {
    // Official Computer exec is intentionally arbitrary. A command may write
    // source before succeeding, failing, timing out, or returning pending sync.
    return true;
  }
  if (result.toolName !== 'write' && result.toolName !== 'edit') {
    return false;
  }
  if (!isRecord(result.result)) {
    return false;
  }
  if (
    result.result.kind === 'workspace-mutation-receipt' &&
    result.result.version === 1 &&
    result.result.committed === true &&
    result.result.acknowledgement === 'complete' &&
    result.result.tool === result.toolName
  ) {
    return true;
  }
  if (typeof result.result.path !== 'string' || typeof result.result.error === 'string') {
    return false;
  }
  return result.toolName === 'write'
    ? Number.isSafeInteger(result.result.bytesWritten) && Number(result.result.bytesWritten) >= 0
    : Number.isSafeInteger(result.result.editsApplied) && Number(result.result.editsApplied) > 0;
}

function isDependencyMutationResult(result: { toolName: string; result?: unknown }): boolean {
  return result.toolName === 'npmInstall';
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
  return (
    isGhostbuildToolResult(result) &&
    result.ok &&
    isRecord(result.data) &&
    result.data.state === 'awaiting-approval' &&
    (expectedRevision === undefined || result.data.revision === expectedRevision)
  );
}

function isProductionDeployResult(result: unknown): boolean {
  return isGhostbuildToolResult(result) && result.ok && isRecord(result.data) && result.data.state === 'deployed';
}
