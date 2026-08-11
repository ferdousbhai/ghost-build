import { getToolInvocation, type GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import {
  COMPUTER_AI_TOOL_OPTIONS,
  COMPUTER_EXEC_APPLICATION_POLICY,
  computerSyncUnconfirmedToolResult,
} from 'ghostbuild-agent/cloudflare-computer';
import { createAITools } from '@cloudflare/computer/tools';
import type { GhostbuildToolSet } from 'ghostbuild-agent/types';
import { isVirtualDocPath, readVirtualDoc, type VirtualDocOverrides } from 'ghostbuild-agent/virtual-docs';
import {
  applyLineEdits,
  lineAnchoredRead,
  lineEditBaseTag,
  lineEditToolParameters,
  type LineEditToolInput,
} from 'ghostbuild-agent/line-edit';
import { MODEL_TOOL_INPUT_SCHEMAS, MODEL_TOOL_NAMES, type ModelToolName } from 'ghostbuild-agent/model-tool-inputs';
import { parseNpmInstallCommand } from 'ghostbuild-agent/tools/npmInstall';
import { isGhostbuildToolResult, toolFailure } from 'ghostbuild-agent/tool-result';
import type { BuilderWorkspaceApi } from '~/agents/builder-workspace-api';
import type { BuilderValidationStage } from '~/lib/common/builder-validation-progress';
import type { Tool } from 'ghostbuild-agent/tool';
import { z, type ZodType } from 'zod';

type ToolSet = Record<string, Tool>;

type BuilderOperationContext = {
  onValidationStage?: (toolCallId: string, stage: BuilderValidationStage | null) => void;
  runWithKeepAlive: <T>(operation: () => Promise<T>) => Promise<T>;
  virtualDocs?: VirtualDocOverrides;
};

type ToolResultEvent = {
  toolName: string;
  result: unknown;
};

type TurnStatefulToolCoordinator = <T>(toolName: string, operation: () => Promise<T>) => Promise<T>;

type AutoValidatedResult = Record<string, unknown> & {
  validation?: unknown;
  dependencyMutation?: boolean;
};

export function createWorkersAiTools(
  workspace: BuilderWorkspaceApi,
  operationContext: BuilderOperationContext,
): GhostbuildToolSet {
  const coordinateStatefulTool = createTurnStatefulToolCoordinator(operationContext.runWithKeepAlive);
  const computerTools = createAITools({
    workspace: workspace.computer,
    ...COMPUTER_AI_TOOL_OPTIONS,
  }) as unknown as ToolSet;
  const write = computerTools.write;
  if (!write) {
    throw new Error('Cloudflare Computer did not expose the required write tool.');
  }
  const tools: GhostbuildToolSet = {
    read: lineAnchoredReadTool(workspace),
    write,
    edit: lineAnchoredEditTool(workspace),
    exec: streamingExecTool(workspace),
  };

  for (const toolName of MODEL_TOOL_NAMES) {
    tools[toolName] = computerWorkspaceTool(
      toolName,
      tools[toolName],
      workspace,
      operationContext,
      coordinateStatefulTool,
    );
  }
  return tools;
}

function lineAnchoredReadTool(workspace: BuilderWorkspaceApi): Tool {
  return {
    description:
      'Read a UTF-8 project file as numbered lines. Returns a compact base snapshot tag required by edit. Output is bounded; use offset and limit to continue.',
    inputSchema: MODEL_TOOL_INPUT_SCHEMAS.read,
    execute: async (input) => {
      const parsed = input as { path: string; offset?: number; limit?: number };
      const file = await workspace.readText(parsed.path);
      return lineAnchoredRead({
        path: file.path,
        content: file.content,
        sha256: file.sha256,
        offset: parsed.offset,
        limit: parsed.limit,
        maxLines: COMPUTER_AI_TOOL_OPTIONS.read.maxLines,
        maxBytes: COMPUTER_AI_TOOL_OPTIONS.read.maxBytes,
      });
    },
  };
}

function streamingExecTool(workspace: BuilderWorkspaceApi): Tool {
  return {
    description: 'Run a shell command in the project workspace using its Cloudflare Container.',
    inputSchema: MODEL_TOOL_INPUT_SCHEMAS.exec,
    execute: async (input, options) => {
      const parsed = input as { command: string; cwd?: string; backend?: string };
      const result = await workspace.executeCommand({
        command: parsed.command,
        cwd: parsed.cwd,
        backend: parsed.backend,
        onUpdate: options.onUpdate,
        abortSignal: options.abortSignal,
      });
      return {
        command: parsed.command,
        cwd: parsed.cwd ?? null,
        backend: parsed.backend ?? 'container-shell',
        ...result,
        ...(result.exitCode === 0 ? {} : { error: `Command exited with code ${result.exitCode}.` }),
      };
    },
  };
}

function lineAnchoredEditTool(workspace: BuilderWorkspaceApi): Tool {
  return {
    description:
      'Edit one existing file by replacing numbered original line ranges or inserting after an original line. The base tag must come from the latest read or successful edit. All operations address the same original snapshot and must not overlap.',
    inputSchema: lineEditToolParameters,
    execute: async (input) => {
      const parsed = lineEditToolParameters.parse(input) as LineEditToolInput;
      const before = await workspace.readText(parsed.path);
      const liveBase = lineEditBaseTag(before.sha256);
      if (parsed.base !== liveBase) {
        throw new Error(
          `Edit rejected because ${parsed.path} changed after it was read. Read the file again and use its current base tag.`,
        );
      }
      const applied = applyLineEdits(before.content, parsed.edits);
      await workspace.computer.fs.writeFile(parsed.path, new TextEncoder().encode(applied.content));
      const after = await workspace.readText(parsed.path);
      return {
        path: after.path,
        base: lineEditBaseTag(after.sha256),
        editsApplied: applied.editsApplied,
        firstChangedLine: applied.firstChangedLine,
        totalLines: countLogicalLines(after.content),
      };
    },
  };
}

function countLogicalLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return normalized.endsWith('\n') ? normalized.slice(0, -1).split('\n').length : normalized.split('\n').length;
}

function computerWorkspaceTool(
  toolName: ModelToolName,
  definition: Tool,
  workspace: BuilderWorkspaceApi,
  context: BuilderOperationContext,
  coordinateStatefulTool: TurnStatefulToolCoordinator,
): Tool {
  if (definition.type === 'provider') {
    throw new TypeError(`Computer tool ${toolName} must be executed by Ghostbuild, not by the model provider.`);
  }
  return {
    ...definition,
    description:
      toolName === 'exec'
        ? `Run a shell command in the project workspace using its Cloudflare Container.\n\n${COMPUTER_EXEC_APPLICATION_POLICY}\nUse read for Ghostbuild guidance under /home/project/.ghost/docs/.`
        : definition.description,
    execute: async (input, options) => {
      options.abortSignal?.throwIfAborted();
      return coordinateStatefulTool(toolName, async () => {
        options.abortSignal?.throwIfAborted();

        const virtualDoc =
          toolName === 'read'
            ? readVirtualDoc(input as { path: string; offset?: number; limit?: number }, context.virtualDocs)
            : null;
        if (virtualDoc) {
          return virtualDoc;
        }
        if ((toolName === 'write' || toolName === 'edit') && isPathInput(input) && isVirtualDocPath(input.path)) {
          return { error: 'Ghostbuild documentation is an immutable virtual filesystem overlay.' };
        }

        if (toolName === 'exec' && isExecInput(input) && isFullValidationCommand(input.command)) {
          const validation = await validateWorkspace(workspace, context, options.toolCallId, options.abortSignal);
          return attachValidation({ command: input.command }, validation);
        }

        let result: unknown;
        try {
          if (!definition.execute) {
            throw new Error(`${toolName} is not executable.`);
          }

          const dependencyCommand =
            toolName === 'exec' && isExecInput(input) ? parseNpmInstallCommand(input.command) : null;
          if (dependencyCommand) {
            result = await workspace.installDependencies({
              toolCallId: options.toolCallId,
              input: { mode: dependencyCommand.mode, packages: dependencyCommand.packages.join(' ') || undefined },
              mode: dependencyCommand.mode,
              packages: dependencyCommand.packages,
            });
            result = markDependencyMutation(result);
          } else {
            result =
              toolName === 'read'
                ? await definition.execute(input, options)
                : await workspace.executeToolOnce(options.toolCallId, toolName, input, () =>
                    definition.execute!(input, options),
                  );
          }
        } catch (error) {
          options.abortSignal?.throwIfAborted();
          const syncResult = computerSyncUnconfirmedToolResult(error);
          result =
            syncResult ??
            (error instanceof Error
              ? {
                  error:
                    error.message.length <= 4_000
                      ? error.message
                      : `${toolName} failed; its unusually large internal error was omitted from the model response.`,
                }
              : isRecord(error)
                ? error
                : { error: String(error) });
        }

        return result;
      });
    },
  };
}

async function validateWorkspace(
  workspace: BuilderWorkspaceApi,
  context: BuilderOperationContext,
  toolCallId: string,
  abortSignal?: AbortSignal,
) {
  abortSignal?.throwIfAborted();
  const validationToolCallId = await derivedValidationToolCallId(toolCallId);
  context.onValidationStage?.(toolCallId, 'computer validation');
  try {
    return await workspace.validate({
      toolCallId: validationToolCallId,
      input: {},
      abortSignal,
    });
  } catch (error) {
    abortSignal?.throwIfAborted();
    return toolFailure(error instanceof Error ? error.message : String(error));
  } finally {
    context.onValidationStage?.(toolCallId, null);
  }
}

async function derivedValidationToolCallId(toolCallId: string): Promise<string> {
  if (toolCallId.length <= 501) {
    return `${toolCallId}:validation`;
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(toolCallId)));
  return `validation:${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function attachValidation(result: unknown, validation: unknown): AutoValidatedResult {
  if (isRecord(result)) {
    return { ...result, validation };
  }
  return { result, validation };
}

function markDependencyMutation(result: unknown): unknown {
  return { ...attachValidationMarker(result), dependencyMutation: true };
}

function attachValidationMarker(result: unknown): AutoValidatedResult {
  return isRecord(result) ? { ...result } : { result };
}

function isExecInput(input: unknown): input is { command: string } {
  return isRecord(input) && typeof input.command === 'string';
}

function isFullValidationCommand(command: string): boolean {
  return /^(?:cd\s+\/home\/project\s*&&\s*)?pnpm\s+run\s+validate(?:\s+2>&1)?$/.test(command.trim());
}

function isPathInput(input: unknown): input is { path: string } {
  return isRecord(input) && typeof input.path === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function createTurnStatefulToolCoordinator(
  runWithKeepAlive: <T>(operation: () => Promise<T>) => Promise<T>,
): TurnStatefulToolCoordinator {
  let tail = Promise.resolve();
  return (toolName, operation) => {
    if (toolName === 'read') {
      return operation();
    }
    const scheduled = tail.then(() => runWithKeepAlive(operation));
    tail = scheduled.then(
      () => undefined,
      () => undefined,
    );
    return scheduled;
  };
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

export function getValidatedBuildCompletion(
  messages: GhostbuildMessage[],
  currentStepResults: ReadonlyArray<ToolResultEvent> = [],
): string | undefined {
  const lastUserIndex = messages.findLastIndex((message) => message.role === 'user');
  if (lastUserIndex === -1) {
    return undefined;
  }

  const results = [
    ...collectToolResults(messages).filter(({ messageIndex }) => messageIndex > lastUserIndex),
    ...currentStepResults,
  ];
  const validation = latestSuccessfulValidation(results);
  if (!validation) {
    return undefined;
  }

  return 'Done. I built and validated the app. It is ready for the user to review and deploy.';
}

function latestSuccessfulValidation(results: ReadonlyArray<ToolResultEvent>): unknown | undefined {
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const result = results[index]?.result;
    const candidate = validationResult(result);
    if (isRecord(result) && 'validation' in result) {
      return isSuccessfulValidationResult(candidate) ? candidate : undefined;
    }
  }
  return undefined;
}

function validationResult(result: unknown): unknown {
  return isRecord(result) ? result.validation : undefined;
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
      return [{ messageIndex, toolName: invocation.toolName, result: invocation.output }];
    }),
  );
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

function validationNextAction(result: unknown): 'prepare-deployment' | undefined {
  return isGhostbuildToolResult(result) && isRecord(result.data) && result.data.nextAction === 'prepare-deployment'
    ? 'prepare-deployment'
    : undefined;
}
