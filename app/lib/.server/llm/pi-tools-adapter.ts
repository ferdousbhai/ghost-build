import type { AgentTool } from '@earendil-works/pi-agent-core';
import { adaptPiTool, type ToolDefinition, type ToolInputSchema } from '@summonghost/pi-tool-adapter';
import { MODEL_TOOL_NAMES, type ModelToolName } from 'ghostbuild-agent/model-tool-inputs';
import type { Tool } from 'ghostbuild-agent/tool';
import type { BuilderWorkspaceApi } from '~/agents/builder-workspace-api';
import type { BuilderValidationStage } from '~/lib/common/builder-validation-progress';
import type { BuilderSkillReader } from './builder-skills';
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
};

/** Adapt the four canonical workspace tools to Pi's validated tool contract. */
export function createPiToolBundle(
  workspace: BuilderWorkspaceApi,
  operationContext: BuilderOperationContext,
  skillReader?: BuilderSkillReader,
): Record<string, AgentTool> {
  const canonicalTools = createWorkersAiTools(workspace, operationContext, skillReader);
  return Object.fromEntries(
    MODEL_TOOL_NAMES.map((name) => [name, adaptTool(name, canonicalTools[name], toolLabels[name])]),
  );
}

export function piToolsToList(tools: Record<string, AgentTool>): AgentTool[] {
  return Object.values(tools);
}

function adaptTool(name: ModelToolName, definition: Tool, label: string): AgentTool {
  const canonical = definition as unknown as ToolDefinition;
  if (!canonical.inputSchema) {
    throw new Error(`${name} does not define an input schema.`);
  }

  return adaptPiTool({
    name,
    label,
    definition: {
      ...canonical,
      inputSchema: canonical.inputSchema as ToolInputSchema,
    },
  }) as AgentTool;
}
