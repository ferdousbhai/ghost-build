import { getToolInvocation, type GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import {
  COMPUTER_AI_TOOL_OPTIONS,
  COMPUTER_DEFAULT_SHELL_BACKEND,
  COMPUTER_EXEC_APPLICATION_POLICY,
  computerSyncUnconfirmedToolResult,
} from 'ghostbuild-agent/cloudflare-computer';
import type { GhostbuildToolSet } from 'ghostbuild-agent/types';
import {
  applyLineEdits,
  lineAnchoredRead,
  lineEditBaseTag,
  lineEditToolParameters,
  type LineEditToolInput,
} from 'ghostbuild-agent/line-edit';
import {
  MODEL_TOOL_INPUT_SCHEMAS,
  WORKSPACE_TOOL_NAMES,
  type WorkspaceToolName,
} from 'ghostbuild-agent/model-tool-inputs';
import { parseNpmInstallCommand } from 'ghostbuild-agent/tools/npmInstall';
import { isGhostbuildToolResult, toolFailure } from 'ghostbuild-agent/tool-result';
import { isWorkspaceToolOperationIndeterminateError, type BuilderWorkspaceApi } from '~/agents/builder-workspace-api';
import type { BuilderValidationStage } from '~/lib/common/builder-validation-progress';
import type { Tool } from 'ghostbuild-agent/tool';
import { type BuilderSkillReader, isBuilderSkillPath } from './builder-skills';
import { cloudflareDocsSearchTool } from './cloudflare-docs-search';
import { sha256Hex } from '~/lib/hex-digest';

type BuilderOperationContext = {
  onValidationStage?: (toolCallId: string, stage: BuilderValidationStage | null) => void;
  runWithKeepAlive: <T>(operation: () => Promise<T>) => Promise<T>;
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
  skillReader?: BuilderSkillReader,
): GhostbuildToolSet {
  const coordinateStatefulTool = createTurnStatefulToolCoordinator(operationContext.runWithKeepAlive);
  const tools: GhostbuildToolSet = {
    read: lineAnchoredReadTool(workspace, skillReader),
    write: abortAwareWriteTool(workspace),
    edit: lineAnchoredEditTool(workspace),
    exec: streamingExecTool(workspace),
    // Stateless and remote: it must not take the workspace operation lane.
    search_cloudflare_docs: cloudflareDocsSearchTool(),
  };

  for (const toolName of WORKSPACE_TOOL_NAMES) {
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

function lineAnchoredReadTool(workspace: BuilderWorkspaceApi, skillReader?: BuilderSkillReader): Tool {
  return {
    description:
      'Read a UTF-8 project or /__skills__/ reference file as numbered lines. Project reads return a compact base snapshot tag required by edit. Skill files are read-only. Output is bounded; use offset and limit to continue.',
    inputSchema: MODEL_TOOL_INPUT_SCHEMAS.read,
    execute: async (input, options) => {
      const parsed = MODEL_TOOL_INPUT_SCHEMAS.read.parse(input);
      options.abortSignal?.throwIfAborted();
      const skillResult = isBuilderSkillPath(parsed.path) ? await skillReader?.read(parsed.path) : null;
      if (skillResult) {
        return lineAnchoredRead({
          path: parsed.path,
          content: skillResult.content,
          sha256: await sha256Hex(skillResult.content),
          offset: parsed.offset,
          limit: parsed.limit,
          maxLines: COMPUTER_AI_TOOL_OPTIONS.read.maxLines,
          maxBytes: COMPUTER_AI_TOOL_OPTIONS.read.maxBytes,
        });
      }
      if (isBuilderSkillPath(parsed.path)) {
        throw new Error(`Skill reference not found: ${parsed.path}`);
      }
      const file = await workspace.readText(parsed.path, options.abortSignal);
      options.abortSignal?.throwIfAborted();
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

function abortAwareWriteTool(workspace: BuilderWorkspaceApi): Tool {
  return {
    description: 'Write content to a file. Overwrites any existing file at the path.',
    inputSchema: MODEL_TOOL_INPUT_SCHEMAS.write,
    execute: async (input, options) => {
      const parsed = MODEL_TOOL_INPUT_SCHEMAS.write.parse(input);
      if (isBuilderSkillPath(parsed.path)) {
        throw new Error(`Skill files are read-only: ${parsed.path}`);
      }
      const bytes = new TextEncoder().encode(parsed.content);
      if (bytes.byteLength > COMPUTER_AI_TOOL_OPTIONS.write.maxBytes) {
        return {
          error: `Content too large: ${bytes.byteLength} bytes exceeds the ${COMPUTER_AI_TOOL_OPTIONS.write.maxBytes}-byte write cap. Use the edit tool for incremental changes to existing files, or split the write into smaller pieces.`,
        };
      }

      options.abortSignal?.throwIfAborted();
      let mode: number | undefined;
      try {
        mode = (await workspace.computer.fs.stat(parsed.path)).mode;
      } catch (error) {
        options.abortSignal?.throwIfAborted();
        if (!isMissingFileError(error)) {
          throw error;
        }
      }
      options.abortSignal?.throwIfAborted();
      await workspace.computer.fs.writeFile(parsed.path, bytes, mode === undefined ? undefined : { mode });
      options.abortSignal?.throwIfAborted();
      return { path: parsed.path, bytesWritten: bytes.byteLength };
    },
  };
}

type ExecToolReport = {
  command: string;
  cwd: string | null;
  backend: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  streamTruncated?: boolean;
  error?: string;
};

function streamingExecTool(workspace: BuilderWorkspaceApi): Tool {
  return {
    description: 'Run a shell command in the project workspace using its Cloudflare Container.',
    inputSchema: MODEL_TOOL_INPUT_SCHEMAS.exec,
    execute: async (input, options) => {
      const parsed = MODEL_TOOL_INPUT_SCHEMAS.exec.parse(input);
      options.abortSignal?.throwIfAborted();
      const result = await workspace.executeCommand({
        command: parsed.command,
        cwd: parsed.cwd,
        onUpdate: options.onUpdate,
        abortSignal: options.abortSignal,
      });
      options.abortSignal?.throwIfAborted();
      const report: ExecToolReport = {
        command: parsed.command,
        cwd: parsed.cwd ?? null,
        backend: COMPUTER_DEFAULT_SHELL_BACKEND,
        ...result,
      };
      if (result.exitCode !== 0) {
        report.error = `Command exited with code ${result.exitCode}.`;
      }
      return report;
    },
  };
}

function lineAnchoredEditTool(workspace: BuilderWorkspaceApi): Tool {
  return {
    description:
      'Edit one existing file by replacing numbered original line ranges or inserting after an original line. The base tag must come from the latest read or successful edit. All operations address the same original snapshot and must not overlap.',
    inputSchema: lineEditToolParameters,
    execute: async (input, options) => {
      const parsed: LineEditToolInput = lineEditToolParameters.parse(input);
      if (isBuilderSkillPath(parsed.path)) {
        throw new Error(`Skill files are read-only: ${parsed.path}`);
      }
      options.abortSignal?.throwIfAborted();
      const before = await workspace.readText(parsed.path, options.abortSignal);
      options.abortSignal?.throwIfAborted();
      const liveBase = lineEditBaseTag(before.sha256);
      if (parsed.base !== liveBase) {
        throw new Error(
          `Edit rejected because ${parsed.path} changed after it was read. Read the file again and use its current base tag.`,
        );
      }
      const applied = applyLineEdits(before.content, parsed.edits);
      options.abortSignal?.throwIfAborted();
      await workspace.computer.fs.writeFile(parsed.path, new TextEncoder().encode(applied.content));
      options.abortSignal?.throwIfAborted();
      const after = await workspace.readText(parsed.path, options.abortSignal);
      options.abortSignal?.throwIfAborted();
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
  toolName: WorkspaceToolName,
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
        ? `Run a shell command in the project workspace using its Cloudflare Container.\n\n${COMPUTER_EXEC_APPLICATION_POLICY}`
        : definition.description,
    execute: async (input, options) => {
      options.abortSignal?.throwIfAborted();
      return coordinateStatefulTool(toolName, async () => {
        options.abortSignal?.throwIfAborted();

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
            options.abortSignal?.throwIfAborted();
            const installRequest: Parameters<BuilderWorkspaceApi['installDependencies']>[0] = {
              toolCallId: options.toolCallId,
              input: { mode: dependencyCommand.mode, packages: dependencyCommand.packages.join(' ') || undefined },
              mode: dependencyCommand.mode,
              packages: dependencyCommand.packages,
            };
            if (options.abortSignal) {
              installRequest.abortSignal = options.abortSignal;
            }
            result = await workspace.installDependencies(installRequest);
            options.abortSignal?.throwIfAborted();
            result = markDependencyMutation(result);
          } else {
            result =
              toolName === 'read'
                ? await definition.execute(input, options)
                : await workspace.executeToolOnce(
                    options.toolCallId,
                    toolName,
                    input,
                    async () => {
                      options.abortSignal?.throwIfAborted();
                      const executionResult = await definition.execute!(input, options);
                      options.abortSignal?.throwIfAborted();
                      return executionResult;
                    },
                    options.abortSignal,
                  );
          }
          options.abortSignal?.throwIfAborted();
        } catch (error) {
          if (isWorkspaceToolOperationIndeterminateError(error)) {
            throw error;
          }
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
    if (isWorkspaceToolOperationIndeterminateError(error)) {
      throw error;
    }
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
  return `validation:${await sha256Hex(toolCallId)}`;
}

function attachValidation(result: unknown, validation: unknown): AutoValidatedResult {
  if (isRecord(result)) {
    return { ...result, validation };
  }
  return { result, validation };
}

function markDependencyMutation(result: unknown): AutoValidatedResult {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isMissingFileError(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }
  if (error.code === 'ENOENT') {
    return true;
  }
  return typeof error.message === 'string' && /ENOENT|no such file/i.test(error.message);
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

  return 'Done. I built and validated the app. Deployment is starting automatically.';
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
