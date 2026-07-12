import { getToolInvocation, messageText, type GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { deployTool } from 'ghostbuild-agent/tools/deploy';
import { editTool } from 'ghostbuild-agent/tools/edit';
import { lookupDocsTool } from 'ghostbuild-agent/tools/lookupDocs';
import { npmInstallTool } from 'ghostbuild-agent/tools/npmInstall';
import { viewTool } from 'ghostbuild-agent/tools/view';
import { writeFileTool } from 'ghostbuild-agent/tools/writeFile';
import type { GhostbuildToolName, GhostbuildToolSet } from 'ghostbuild-agent/types';
import { z, type ZodType } from 'zod';

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
    lookupDocs: lookupDocsTool(),
    npmInstall: npmInstallTool,
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
    const lastStarterTemplateDeployAfterRouteIndex = toolResultsAfterLastUser.findLastIndex(
      ({ toolName, result }, index) =>
        toolName === 'deploy' && index > lastAppRouteMutationAfterUserIndex && isStarterTemplateDeployFailure(result),
    );
    if (lastAppRouteMutationAfterUserIndex === -1 || lastStarterTemplateDeployAfterRouteIndex !== -1) {
      return { type: 'tool', toolName: 'writeFile' };
    }
  }

  const lastMutationAfterUserIndex = toolResultsAfterLastUser.findLastIndex(
    ({ toolName }) => toolName === 'writeFile' || toolName === 'edit',
  );

  if (lastMutationAfterUserIndex !== -1) {
    const lastDeployAfterMutationIndex = toolResultsAfterLastUser.findLastIndex(
      ({ toolName }, index) => toolName === 'deploy' && index > lastMutationAfterUserIndex,
    );
    if (lastDeployAfterMutationIndex === -1) {
      return { type: 'tool', toolName: 'deploy' };
    }
    const deployResult = toolResultsAfterLastUser[lastDeployAfterMutationIndex].result;
    if (isSuccessfulDeployResult(deployResult)) {
      return 'none';
    }
    return hasReadOnlyLoopAfterDeployFailure(toolResultsAfterLastUser, lastDeployAfterMutationIndex)
      ? { type: 'tool', toolName: 'writeFile' }
      : 'required';
  }

  if (looksLikeBuildRequest) {
    return { type: 'tool', toolName: 'writeFile' };
  }

  const lastMutationIndex = toolResults.findLastIndex(
    ({ toolName }) => toolName === 'writeFile' || toolName === 'edit',
  );
  if (lastMutationIndex === -1) {
    return 'auto';
  }

  const lastDeployIndex = toolResults.findLastIndex(({ toolName }) => toolName === 'deploy');
  if (lastDeployIndex < lastMutationIndex) {
    return { type: 'tool', toolName: 'deploy' };
  }
  const deployResult = toolResults[lastDeployIndex].result;
  if (isSuccessfulDeployResult(deployResult)) {
    return 'none';
  }
  return hasReadOnlyLoopAfterDeployFailure(toolResults, lastDeployIndex)
    ? { type: 'tool', toolName: 'writeFile' }
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
  const lastMutationAfterUserIndex = toolResultsAfterLastUser.findLastIndex(
    ({ toolName }) => toolName === 'writeFile' || toolName === 'edit',
  );
  if (lastMutationAfterUserIndex === -1) {
    return undefined;
  }

  const successfulDeployResult = toolResultsAfterLastUser.findLast(
    ({ toolName, result }, index) =>
      toolName === 'deploy' && index > lastMutationAfterUserIndex && isSuccessfulDeployResult(result),
  )?.result;
  if (!successfulDeployResult) {
    return undefined;
  }

  if (isGuestAppCheckResult(successfulDeployResult)) {
    return 'Done. I built and checked the app, and it is ready to preview here. Sign in when you are ready to deploy it to Cloudflare production.';
  }

  if (isProductionDeployResult(successfulDeployResult)) {
    return 'Done. I built, validated, and deployed the app to Cloudflare production.';
  }

  return 'Done. I built and validated the app, and it is ready to preview.';
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
    'Do not call deploy until the requested experience is implemented in src/routes/index.tsx.',
  ].join('\n');
}

function collectToolResults(messages: GhostbuildMessage[]): Array<{
  messageIndex: number;
  toolName: string;
  result: string;
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
          result: typeof invocation.result === 'string' ? invocation.result : JSON.stringify(invocation.result),
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

function hasReadOnlyLoopAfterDeployFailure(toolResults: Array<{ toolName: string }>, deployIndex: number): boolean {
  const toolResultsAfterDeploy = toolResults.slice(deployIndex + 1);
  if (toolResultsAfterDeploy.some(({ toolName }) => toolName === 'writeFile' || toolName === 'edit')) {
    return false;
  }
  return toolResultsAfterDeploy.filter(({ toolName }) => toolName === 'view' || toolName === 'lookupDocs').length >= 3;
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

function isStarterTemplateDeployFailure(result: string): boolean {
  const normalized = result.toLowerCase();
  return (
    normalized.includes('generated app route still matches the starter template') ||
    (normalized.includes('starter template') && normalized.includes('route'))
  );
}

function isSuccessfulDeployResult(result: string): boolean {
  return (
    isGuestAppCheckResult(result) ||
    result.includes('Ghostbuild preview validation complete') ||
    isProductionDeployResult(result)
  );
}

function isGuestAppCheckResult(result: string): boolean {
  return result.includes('Ghostbuild app check complete');
}

function isProductionDeployResult(result: string): boolean {
  return result.includes('Uploaded ghostbuild') || result.includes('Deployed ghostbuild');
}
