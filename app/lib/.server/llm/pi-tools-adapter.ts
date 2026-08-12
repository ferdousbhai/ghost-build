import type { AgentTool } from '@earendil-works/pi-agent-core';
import { adaptPiTool, type ToolDefinition, type ToolInputSchema } from '@summonghost/pi-tool-adapter';
import { MODEL_TOOL_NAMES, type ModelToolName } from 'ghostbuild-agent/model-tool-inputs';
import type { Tool } from 'ghostbuild-agent/tool';
import type { BuilderWorkspaceApi } from '~/agents/builder-workspace-api';
import type { BuilderValidationStage } from '~/lib/common/builder-validation-progress';
import type { ToolSet } from 'ai';
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

/** Adapt workspace and official Agent Skills tools to Pi's validated tool contract. */
export function createPiToolBundle(
  workspace: BuilderWorkspaceApi,
  operationContext: BuilderOperationContext,
  additionalTools: ToolSet = {},
): Record<string, AgentTool> {
  const canonicalTools = createWorkersAiTools(workspace, operationContext);
  const tools: Record<string, AgentTool> = Object.fromEntries(
    MODEL_TOOL_NAMES.map((name) => [name, adaptTool(name, canonicalTools[name], toolLabels[name])]),
  );
  for (const [name, definition] of Object.entries(additionalTools)) {
    if (name in tools) {
      throw new Error(`Additional tool ${name} conflicts with a workspace tool.`);
    }
    tools[name] = adaptTool(name, definition, skillToolLabel(name));
  }
  return tools;
}

export function piToolsToList(tools: Record<string, AgentTool>): AgentTool[] {
  return Object.values(tools);
}

function adaptTool(name: string, definition: Tool | ToolSet[string], label: string): AgentTool {
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

function skillToolLabel(name: string): string {
  return name === 'activate_skill' ? 'Activate guidance' : name === 'read_skill_resource' ? 'Read guidance' : name;
}
