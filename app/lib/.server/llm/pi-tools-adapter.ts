import type { Type } from '@earendil-works/pi-ai';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { z, type ZodType } from 'zod';
import { MODEL_TOOL_NAMES, type ModelToolName } from 'ghostbuild-agent/model-tool-inputs';
import type { Tool } from 'ghostbuild-agent/tool';
import type { GhostbuildToolSet } from 'ghostbuild-agent/types';
import type { BuilderWorkspaceApi } from '~/agents/builder-workspace-api';
import type { BuilderValidationStage } from '~/lib/common/builder-validation-progress';
import type { VirtualDocOverrides } from 'ghostbuild-agent/virtual-docs';
import { BUILDER_TURN_TIMEOUTS, BuilderTurnBudgetExceededError } from './builder-turn-budget';
import { createWorkersAiTools } from './workers-ai-tools';

type BuilderOperationContext = {
  onValidationStage?: (toolCallId: string, stage: BuilderValidationStage | null) => void;
  runWithKeepAlive: <T>(operation: () => Promise<T>) => Promise<T>;
  virtualDocs?: VirtualDocOverrides;
};

const toolLabels: Record<ModelToolName, string> = {
  read: 'Read file',
  write: 'Write file',
  edit: 'Edit file',
  exec: 'Run command',
};

/** Build both representations once so Pi execution and prompt accounting share one Zod schema. */
export function createPiToolBundle(
  workspace: BuilderWorkspaceApi,
  operationContext: BuilderOperationContext,
): { canonicalTools: GhostbuildToolSet; piTools: Record<ModelToolName, AgentTool> } {
  const canonicalTools = createWorkersAiTools(workspace, operationContext);
  const piTools = Object.fromEntries(
    MODEL_TOOL_NAMES.map((name) => [name, adaptTool(name, canonicalTools[name])]),
  ) as Record<ModelToolName, AgentTool>;
  return { canonicalTools, piTools };
}

export function piToolsToList(tools: Record<ModelToolName, AgentTool>): AgentTool[] {
  return MODEL_TOOL_NAMES.map((name) => tools[name]);
}

function adaptTool(name: ModelToolName, definition: Tool): AgentTool {
  const parameters = z.toJSONSchema(definition.inputSchema as ZodType) as unknown as ReturnType<typeof Type.Object>;
  return {
    name,
    label: toolLabels[name],
    description: typeof definition.description === 'string' ? definition.description : `${toolLabels[name]}.`,
    parameters,
    execute: async (toolCallId, args, signal, onUpdate) => {
      signal?.throwIfAborted();
      if (!definition.execute) {
        throw new Error(`${name} is not executable.`);
      }
      const timeoutSignal = AbortSignal.timeout(BUILDER_TURN_TIMEOUTS.tools[name]);
      const executionSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      try {
        const result = await definition.execute(args, {
          toolCallId,
          abortSignal: executionSignal,
          onUpdate: onUpdate ? (partialResult) => onUpdate(toPiToolResult(partialResult)) : undefined,
        });
        executionSignal.throwIfAborted();
        return toPiToolResult(result);
      } catch (error) {
        if (timeoutSignal.aborted && !signal?.aborted) {
          throw new BuilderTurnBudgetExceededError('tool_timeout');
        }
        throw error;
      }
    },
  };
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
    return String(result);
  }
}
