import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { z, type ZodType } from 'zod';
import { MODEL_TOOL_NAMES, type ModelToolName } from 'ghostbuild-agent/model-tool-inputs';
import type { Tool } from 'ghostbuild-agent/tool';
import { isWorkspaceToolOperationIndeterminateError, type BuilderWorkspaceApi } from '~/agents/builder-workspace-api';
import type { BuilderValidationStage } from '~/lib/common/builder-validation-progress';
import type { BuilderSkillReader } from './builder-skills';
import { BUILDER_TURN_TIMEOUTS, BuilderTurnBudgetExceededError } from './builder-turn-budget';
import { createWorkersAiTools } from './workers-ai-tools';

type BuilderOperationContext = {
  onValidationStage?: (toolCallId: string, stage: BuilderValidationStage | null) => void;
  runWithKeepAlive: <T>(operation: () => Promise<T>) => Promise<T>;
};

const toolLabels: Record<ModelToolName, string> = {
  read: 'Read file',
  write: 'Write file',
  edit: 'Edit file',
  exec: 'Run command',
  search_cloudflare_docs: 'Search Cloudflare docs',
};

/** Adapt the canonical model tools to Pi's validated tool contract. */
export function createPiToolBundle(
  workspace: BuilderWorkspaceApi,
  operationContext: BuilderOperationContext,
  skillReader?: BuilderSkillReader,
): Record<string, AgentTool> {
  const canonicalTools = createWorkersAiTools(workspace, operationContext, skillReader);
  const tools: Record<string, AgentTool> = Object.fromEntries(
    MODEL_TOOL_NAMES.map((name) => [name, adaptTool(name, canonicalTools[name], toolLabels[name])]),
  );
  return tools;
}

export function piToolsToList(tools: Record<string, AgentTool>): AgentTool[] {
  return Object.values(tools);
}

function adaptTool(name: ModelToolName, definition: Tool, label: string): AgentTool {
  if (!definition.inputSchema) {
    throw new Error(`${name} does not define an input schema.`);
  }
  const inputSchema = definition.inputSchema as ZodType;
  return {
    name,
    label,
    description: definition.description ?? name,
    parameters: z.toJSONSchema(inputSchema, {
      io: 'input',
      target: 'draft-07',
      unrepresentable: 'throw',
    }) as AgentTool['parameters'],
    execute: async (toolCallId, rawInput, signal, onUpdate) => {
      signal?.throwIfAborted();
      const parsed = await inputSchema.safeParseAsync(rawInput);
      if (!parsed.success) {
        throw new Error(`Invalid tool input for "${name}": ${parsed.error.message}`, { cause: parsed.error });
      }
      signal?.throwIfAborted();
      if (!definition.execute) {
        throw new Error(`${name} is not executable.`);
      }

      const timeoutController = new AbortController();
      const timeout = setTimeout(
        () => timeoutController.abort(new BuilderTurnBudgetExceededError('tool_timeout')),
        BUILDER_TURN_TIMEOUTS.tools[name],
      );
      const executionSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
      let updatesOpen = true;
      try {
        const result = await definition.execute(parsed.data, {
          toolCallId,
          abortSignal: executionSignal,
          onUpdate: onUpdate
            ? (partialResult) => {
                if (updatesOpen) {
                  executionSignal.throwIfAborted();
                  onUpdate(toPiToolResult(partialResult));
                }
              }
            : undefined,
        });
        executionSignal.throwIfAborted();
        return toPiToolResult(result);
      } catch (error) {
        if (executionSignal.aborted && !isWorkspaceToolOperationIndeterminateError(error)) {
          executionSignal.throwIfAborted();
        }
        throw error;
      } finally {
        updatesOpen = false;
        clearTimeout(timeout);
      }
    },
  } as AgentTool;
}

function toPiToolResult(result: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: 'text', text: stringifyToolResult(result) }],
    details: result,
  };
}

function stringifyToolResult(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }
  try {
    return JSON.stringify(result) ?? String(result);
  } catch {
    try {
      return String(result);
    } catch {
      return '[Unserializable tool result]';
    }
  }
}
