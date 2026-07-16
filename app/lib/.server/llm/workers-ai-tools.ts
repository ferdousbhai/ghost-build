import { getToolInvocation, messageText, type GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { deployTool } from 'ghostbuild-agent/tools/deploy';
import { editTool } from 'ghostbuild-agent/tools/edit';
import { lookupDocsTool } from 'ghostbuild-agent/tools/lookupDocs';
import { npmInstallTool } from 'ghostbuild-agent/tools/npmInstall';
import { viewTool } from 'ghostbuild-agent/tools/view';
import { writeFileTool } from 'ghostbuild-agent/tools/writeFile';
import { listFilesTool } from 'ghostbuild-agent/tools/listFiles';
import { searchTextTool } from 'ghostbuild-agent/tools/searchText';
import { getDiagnosticsTool } from 'ghostbuild-agent/tools/getDiagnostics';
import { validateProjectTool } from 'ghostbuild-agent/tools/validateProject';
import { isReadOnlyToolName, type GhostbuildToolName, type GhostbuildToolSet } from 'ghostbuild-agent/types';
import { z, type ZodType } from 'zod';
import { isGhostbuildToolResult, toolResultSucceeded } from 'ghostbuild-agent/tool-result';

export type AgentToolChoice = 'auto' | 'none' | 'required' | { type: 'tool'; toolName: GhostbuildToolName };
export type AgentToolSettings = {
  activeTools?: GhostbuildToolName[];
  toolChoice: AgentToolChoice;
};
const GENERATED_APP_ROUTE = '/home/project/src/routes/index.tsx';

export function createWorkersAiTools(): GhostbuildToolSet {
  return {
    deploy: deployTool,
    edit: editTool,
    listFiles: listFilesTool,
    lookupDocs: lookupDocsTool(),
    npmInstall: npmInstallTool,
    getDiagnostics: getDiagnosticsTool,
    searchText: searchTextTool,
    validateProject: validateProjectTool,
    view: viewTool,
    writeFile: writeFileTool,
  };
}

let serializedToolDefinitions: string | undefined;

/** Serialized form approximating the tool definitions included in the model request. */
export function getWorkersAiToolContext(): string {
  serializedToolDefinitions ??= serializeWorkersAiToolDefinitions(createWorkersAiTools());
  return serializedToolDefinitions;
}

export function serializeWorkersAiToolDefinitions(tools: GhostbuildToolSet): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(tools).map(([name, tool]) => [
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
  const lastUserMessage = lastUserIndex === -1 ? undefined : messages[lastUserIndex];
  const lastUserText = lastUserMessage ? messageText(lastUserMessage) : '';
  const looksLikeBuildRequest =
    /\b(build|create|make|add|update|change|fix|implement|ship|validate|deploy|site|page|tool|game|tracker|dashboard)\b/i.test(
      lastUserText,
    );
  const requiresAppRouteMutation = looksLikeNewAppBuildRequest(lastUserText);
  const toolResults = collectToolResults(messages);
  const toolResultsAfterLastUser = toolResults.filter(({ messageIndex }) => messageIndex > lastUserIndex);
  const lastAppRouteMutationAfterUserIndex = toolResultsAfterLastUser.findLastIndex(isAppRouteMutation);

  if (requiresAppRouteMutation) {
    if (lastAppRouteMutationAfterUserIndex === -1) {
      return { type: 'tool', toolName: 'writeFile' };
    }
  }

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

  if (looksLikeBuildRequest) {
    return { type: 'tool', toolName: 'writeFile' };
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
    if (validationLevel(validationResult) === 'fast' && toolResultSucceeded(validationResult)) {
      return { type: 'tool', toolName: 'validateProject' };
    }
    return hasReadOnlyLoopAfterFailure(toolResults, lastValidationIndex)
      ? { type: 'tool', toolName: 'writeFile' }
      : 'required';
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
    const activeTools: GhostbuildToolName[] = [
      'view',
      'listFiles',
      'searchText',
      'edit',
      'writeFile',
      'lookupDocs',
      'npmInstall',
    ];
    if (hasIncompleteDiagnostics(messages)) {
      activeTools.push('getDiagnostics');
    }
    return { activeTools, toolChoice };
  }
  return { toolChoice };
}

function hasIncompleteDiagnostics(messages: GhostbuildMessage[]): boolean {
  const lastUserIndex = messages.findLastIndex((message) => message.role === 'user');
  const incompleteById = new Map<string, boolean>();
  for (const { messageIndex, result } of collectToolResults(messages)) {
    if (messageIndex <= lastUserIndex || !isGhostbuildToolResult(result) || !isRecord(result.data)) {
      continue;
    }
    const diagnosticsId = result.data.diagnosticsId;
    if (typeof diagnosticsId === 'string') {
      incompleteById.set(diagnosticsId, result.coverage?.complete === false && Boolean(result.coverage.nextCursor));
    }
  }
  return [...incompleteById.values()].some(Boolean);
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
    return 'Done. I built and validated the app, including a clean preview smoke check, and it is ready to preview here. Sign in when you are ready to deploy it to Cloudflare production.';
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
    'Current required build step:',
    `The user asked for a new app, and the primary app route has not been replaced yet.${attemptedPaths}`,
    `Your next filesystem action must write the complete requested app to ${GENERATED_APP_ROUTE}.`,
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

function hasReadOnlyLoopAfterFailure(toolResults: Array<{ toolName: string }>, failureIndex: number): boolean {
  const toolResultsAfterFailure = toolResults.slice(failureIndex + 1);
  if (toolResultsAfterFailure.some(isMutationResult)) {
    return false;
  }
  return toolResultsAfterFailure.filter(({ toolName }) => isReadOnlyToolName(toolName)).length >= 3;
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

function validationLevel(result: unknown): 'fast' | 'full' | undefined {
  if (!isGhostbuildToolResult(result) || !isRecord(result.data)) {
    return undefined;
  }
  return result.data.level === 'fast' || result.data.level === 'full' ? result.data.level : undefined;
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
