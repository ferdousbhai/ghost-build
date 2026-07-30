import { getToolInvocation, messageText, type GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
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

export type AgentToolChoice = 'auto' | 'none' | 'required' | { type: 'tool'; toolName: GhostbuildToolName };
export type AgentToolSettings = {
  activeTools?: GhostbuildToolName[];
  toolChoice: AgentToolChoice;
};
const GENERATED_APP_ROUTE = '/home/project/src/routes/index.tsx';

export function createWorkersAiTools(
  workspace: BuilderWorkspaceRepository,
  operationContext: BuilderOperationContext,
): GhostbuildToolSet {
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
    tools[toolName] = serverWorkspaceTool(toolName, tools[toolName], workspace);
  }
  for (const toolName of ['lookupDocs', 'npmInstall', 'validateProject', 'deploy'] as const) {
    tools[toolName] = serverOperationTool(toolName, tools[toolName], workspace, operationContext);
  }
  return tools;
}

export function getNextServerToolStepSettings(
  toolResults: ReadonlyArray<{ toolName: string; output: unknown }>,
  fallback: AgentToolSettings,
): AgentToolSettings {
  const latest = toolResults.at(-1);
  if (!latest) {
    return fallback;
  }
  if (
    (latest.toolName === 'edit' || latest.toolName === 'writeFile' || latest.toolName === 'npmInstall') &&
    toolResultSucceeded(latest.output)
  ) {
    return {
      activeTools: ['validateProject'],
      toolChoice: 'required',
    };
  }
  if (latest.toolName === 'validateProject') {
    if (isSuccessfulValidationResult(latest.output)) {
      return validationNextAction(latest.output) === 'prepare-deployment'
        ? { activeTools: ['deploy'], toolChoice: 'required' }
        : { toolChoice: 'none' };
    }
    return {
      activeTools: ['view', 'listFiles', 'searchText', 'edit', 'writeFile', 'npmInstall'],
      toolChoice: 'required',
    };
  }
  if (latest.toolName === 'deploy') {
    return { toolChoice: 'none' };
  }
  return fallback;
}

function serverOperationTool(
  toolName: ServerOperationToolName,
  definition: Tool,
  workspace: BuilderWorkspaceRepository,
  context: BuilderOperationContext,
): Tool {
  return {
    ...definition,
    execute: async (input, options) => {
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
): Tool {
  return {
    ...definition,
    execute: async (input, options) => {
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

export function getBuildToolChoice(messages: GhostbuildMessage[]): AgentToolChoice {
  const lastUserIndex = messages.findLastIndex((message) => message.role === 'user');
  const toolResults = collectToolResults(messages);
  const toolResultsAfterLastUser = toolResults.filter(({ messageIndex }) => messageIndex > lastUserIndex);

  const lastMutationAfterUserIndex = toolResultsAfterLastUser.findLastIndex(isMutationResult);

  if (lastMutationAfterUserIndex !== -1) {
    return getPostMutationToolChoice(toolResultsAfterLastUser, lastMutationAfterUserIndex) ?? 'none';
  }

  const lastMutationIndex = toolResults.findLastIndex(isMutationResult);
  if (lastMutationIndex !== -1) {
    const unfinishedPriorBuild = getPostMutationToolChoice(toolResults, lastMutationIndex);
    if (unfinishedPriorBuild !== undefined) {
      return unfinishedPriorBuild;
    }
  }

  if (toolResultsAfterLastUser.some(({ result }) => !toolResultSucceeded(result))) {
    return 'required';
  }

  return 'auto';
}

function getPostMutationToolChoice(
  toolResults: Array<{ toolName: string; result: unknown }>,
  mutationIndex: number,
): AgentToolChoice | undefined {
  const lastValidationIndex = toolResults.findLastIndex(
    ({ toolName }, index) => toolName === 'validateProject' && index > mutationIndex,
  );
  if (lastValidationIndex === -1) {
    return { type: 'tool', toolName: 'validateProject' };
  }
  const validationResult = toolResults[lastValidationIndex].result;
  if (!isSuccessfulValidationResult(validationResult)) {
    return 'required';
  }
  if (validationNextAction(validationResult) !== 'prepare-deployment') {
    return undefined;
  }
  const lastDeployIndex = toolResults.findLastIndex(
    ({ toolName }, index) => toolName === 'deploy' && index > lastValidationIndex,
  );
  if (lastDeployIndex === -1) {
    return { type: 'tool', toolName: 'deploy' };
  }
  return isSuccessfulDeployResult(toolResults[lastDeployIndex].result, validationRevision(validationResult))
    ? undefined
    : 'required';
}

export function getWorkersAiToolSettings(messages: GhostbuildMessage[]): AgentToolSettings {
  const toolChoice = getBuildToolChoice(messages);
  if (typeof toolChoice === 'object') {
    return {
      activeTools: [toolChoice.toolName],
      toolChoice: 'required',
    };
  }
  if (toolChoice === 'auto') {
    return {
      activeTools: ['view', 'listFiles', 'searchText', 'edit', 'writeFile', 'lookupDocs', 'npmInstall'],
      toolChoice,
    };
  }
  return { toolChoice };
}

export function getValidatedBuildCompletion(messages: GhostbuildMessage[]): string | undefined {
  const lastUserIndex = messages.findLastIndex((message) => message.role === 'user');
  if (lastUserIndex === -1) {
    return undefined;
  }

  const toolResultsAfterLastUser = collectToolResults(messages).filter(
    ({ messageIndex }) => messageIndex > lastUserIndex,
  );
  const lastMutationAfterUserIndex = toolResultsAfterLastUser.findLastIndex(isMutationResult);
  if (lastMutationAfterUserIndex === -1) {
    return undefined;
  }

  const validationIndex = toolResultsAfterLastUser.findLastIndex(
    ({ toolName, result }, index) =>
      toolName === 'validateProject' && index > lastMutationAfterUserIndex && isSuccessfulValidationResult(result),
  );
  if (validationIndex === -1) {
    return undefined;
  }
  const validationResult = toolResultsAfterLastUser[validationIndex].result;
  if (validationNextAction(validationResult) === 'sign-in-required') {
    return 'Done. I built and validated the app in the isolated production build environment, and it is ready to preview here. Sign in when you are ready to deploy it to Cloudflare production.';
  }
  const deployResult = toolResultsAfterLastUser.findLast(
    ({ toolName, result }, index) =>
      toolName === 'deploy' &&
      index > validationIndex &&
      isSuccessfulDeployResult(result, validationRevision(validationResult)),
  )?.result;
  if (!deployResult) {
    return undefined;
  }
  return isProductionDeployResult(deployResult)
    ? 'Done. I built, validated, and deployed the app to Cloudflare production.'
    : 'Done. I built and validated the app. The production deployment plan is ready for your approval.';
}

export function getWorkersAiBuildGuidance(messages: GhostbuildMessage[]): string | undefined {
  const lastUserIndex = messages.findLastIndex((message) => message.role === 'user');
  const lastUserMessage = lastUserIndex === -1 ? undefined : messages[lastUserIndex];
  const lastUserText = lastUserMessage ? messageText(lastUserMessage) : '';
  if (!looksLikeNewAppBuildRequest(lastUserText)) {
    return undefined;
  }

  const toolResultsAfterLastUser = collectToolResults(messages).filter(
    ({ messageIndex }) => messageIndex > lastUserIndex,
  );
  if (toolResultsAfterLastUser.some(isAppRouteMutation)) {
    return undefined;
  }

  const nonRouteWrites = toolResultsAfterLastUser
    .filter(({ toolName }) => toolName === 'writeFile' || toolName === 'edit')
    .map(({ path }) => path)
    .filter((path): path is string => Boolean(path));
  const attemptedPaths =
    nonRouteWrites.length > 0 ? ` Recent non-route file writes were: ${dedupe(nonRouteWrites).join(', ')}.` : '';

  return [
    'Current build target:',
    `The user asked for a new app, and the primary app route has not been replaced yet.${attemptedPaths}`,
    `Implement the complete requested app in ${GENERATED_APP_ROUTE} before validation.`,
    'You may inspect the workspace and consult lookupDocs before choosing the implementation.',
    'Do not write .ghost-* files, check files, marker files, placeholder files, or only src/routes/__root.tsx.',
    'Do not call validateProject or deploy until the requested experience is implemented in src/routes/index.tsx.',
  ].join('\n');
}

function collectToolResults(messages: GhostbuildMessage[]): Array<{
  messageIndex: number;
  toolName: string;
  result: unknown;
  path?: string;
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
          path: getToolInvocationPath(invocation.args, invocation.result),
        },
      ];
    }),
  );
}

function looksLikeNewAppBuildRequest(text: string): boolean {
  return (
    /\b(build|create|generate|scaffold)\b/i.test(text) ||
    /\b(make|ship|implement)\b.*\b(app|site|page|tool|game|tracker|dashboard)\b/i.test(text)
  );
}

function isAppRouteMutation(result: { toolName: string; path?: string }): boolean {
  if (result.toolName !== 'writeFile' && result.toolName !== 'edit') {
    return false;
  }
  return isUserFacingRoutePath(result.path);
}

function isUserFacingRoutePath(path: string | undefined): boolean {
  return /^src\/routes\/(?!__root\.tsx$).+\.(?:[cm]?[jt]sx?)$/i.test(path ?? '');
}

function getToolInvocationPath(args: unknown, result: unknown): string | undefined {
  if (isRecord(args) && typeof args.path === 'string') {
    return normalizeProjectPath(args.path);
  }

  const resultText = typeof result === 'string' ? result : '';
  const match =
    resultText.match(/\b(?:wrote|updated|edited|created)\s+(?:file\s+)?[`'"]?([^`'"\s]+)/i) ??
    resultText.match(/[`'"]?((?:\/home\/project\/|\.\/|\/)?src\/routes\/[^`'"\s]+)[`'"]?/i) ??
    resultText.match(/[`'"]?((?:\/home\/project\/|\.\/|\/)?src\/[^`'"\s]+)[`'"]?/i);
  return match ? normalizeProjectPath(match[1]) : undefined;
}

function normalizeProjectPath(path: string): string {
  let normalized = path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^["'`]+|["'`,.]+$/g, '');
  const projectPrefixIndex = normalized.lastIndexOf('/home/project/');
  if (projectPrefixIndex !== -1) {
    normalized = normalized.slice(projectPrefixIndex + '/home/project/'.length);
  }
  while (normalized.startsWith('./') || normalized.startsWith('/')) {
    normalized = normalized.startsWith('./') ? normalized.slice(2) : normalized.slice(1);
  }
  return normalized;
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isMutationResult(result: { toolName: string; result?: unknown }): boolean {
  return (
    (result.toolName === 'writeFile' || result.toolName === 'edit' || result.toolName === 'npmInstall') &&
    toolResultSucceeded(result.result)
  );
}

function isSuccessfulValidationResult(result: unknown): boolean {
  return (
    isGhostbuildToolResult(result) &&
    result.ok &&
    isRecord(result.data) &&
    result.data.level === 'full' &&
    validationRevision(result) !== undefined
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
