import { Type } from '@earendil-works/pi-ai';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { COMPUTER_SHELL_BACKEND_IDS, type ComputerToolName } from 'ghostbuild-agent/cloudflare-computer';
import { LINE_EDIT_BASE_TAG_HEX_LENGTH, LINE_EDIT_MAX_OPERATIONS } from 'ghostbuild-agent/line-edit';
import { MODEL_TOOL_NAMES } from './workers-ai-tools';
import type { Tool } from 'ghostbuild-agent/tool';
import type { GhostbuildToolSet } from 'ghostbuild-agent/types';
import type { BuilderWorkspaceApi } from '~/agents/builder-workspace-api';
import type { BuilderValidationStage } from '~/lib/common/builder-validation-progress';
import { createWorkersAiTools } from './workers-ai-tools';

type BuilderOperationContext = {
  onValidationStage?: (toolCallId: string, stage: BuilderValidationStage | null) => void;
  runWithKeepAlive: <T>(operation: () => Promise<T>) => Promise<T>;
};

const computerParameters = {
  read: Type.Object({
    path: Type.String(),
    offset: Type.Optional(Type.Integer({ minimum: 1 })),
    limit: Type.Optional(Type.Integer({ minimum: 1 })),
  }),
  ls: Type.Object({ path: Type.String() }),
  write: Type.Object({ path: Type.String(), content: Type.String() }),
  edit: Type.Object({
    path: Type.String(),
    base: Type.String({ pattern: `^[A-F0-9]{${LINE_EDIT_BASE_TAG_HEX_LENGTH}}$` }),
    edits: Type.Array(
      Type.Union([
        Type.Object(
          {
            startLine: Type.Integer({ minimum: 1 }),
            endLine: Type.Integer({ minimum: 1 }),
            content: Type.String(),
          },
          { additionalProperties: false },
        ),
        Type.Object(
          {
            afterLine: Type.Integer({ minimum: 0 }),
            content: Type.String({ minLength: 1 }),
          },
          { additionalProperties: false },
        ),
      ]),
      { minItems: 1, maxItems: LINE_EDIT_MAX_OPERATIONS },
    ),
  }),
  exec: Type.Object({
    command: Type.String(),
    cwd: Type.Optional(Type.String()),
    backend: Type.Optional(Type.Literal(COMPUTER_SHELL_BACKEND_IDS[0])),
  }),
} as const satisfies Record<ComputerToolName, ReturnType<typeof Type.Object>>;

const toolLabels = {
  read: 'Read file',
  ls: 'List files',
  write: 'Write file',
  edit: 'Edit file',
  exec: 'Run command',
} as const;

/**
 * Adapt the canonical Ghostbuild tool wrappers to Pi without duplicating execution policy.
 * The canonical wrappers own mutation idempotency, serialization, sync recovery, and validation.
 */
export function createPiTools(
  workspace: BuilderWorkspaceApi,
  operationContext: BuilderOperationContext,
): Record<string, AgentTool> {
  return createPiToolBundle(workspace, operationContext).piTools;
}

/** Build both tool representations once so prompt accounting keeps the canonical Zod schemas. */
export function createPiToolBundle(
  workspace: BuilderWorkspaceApi,
  operationContext: BuilderOperationContext,
): { canonicalTools: GhostbuildToolSet; piTools: Record<string, AgentTool> } {
  const canonicalTools = createWorkersAiTools(workspace, operationContext);
  const tools: Record<string, AgentTool> = {};

  for (const name of MODEL_TOOL_NAMES) {
    tools[name] = adaptTool(name, toolLabels[name], canonicalTools[name], computerParameters[name]);
  }

  return { canonicalTools, piTools: tools };
}

export function piToolsToList(tools: Record<string, AgentTool>): AgentTool[] {
  return Object.values(tools);
}

function adaptTool<T extends ReturnType<typeof Type.Object>>(
  name: string,
  label: string,
  definition: Tool,
  parameters: T,
): AgentTool<T, unknown> {
  return {
    name,
    label,
    description: typeof definition.description === 'string' ? definition.description : `${label}.`,
    parameters,
    execute: async (toolCallId, args, signal, onUpdate) => {
      signal?.throwIfAborted();
      if (!definition.execute) {
        throw new Error(`${name} is not executable.`);
      }
      const result = await definition.execute(args, {
        toolCallId,
        abortSignal: signal,
        onUpdate: onUpdate ? (partialResult) => onUpdate(toPiToolResult(partialResult)) : undefined,
      });
      signal?.throwIfAborted();
      return toPiToolResult(result);
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
