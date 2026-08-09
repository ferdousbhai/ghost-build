import { Type } from '@earendil-works/pi-ai';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import {
  COMPUTER_SHELL_BACKEND_IDS,
  COMPUTER_TOOL_NAMES,
  type ComputerToolName,
} from 'ghostbuild-agent/cloudflare-computer';
import { docKeys } from 'ghostbuild-agent/references/index';
import type { Tool } from 'ghostbuild-agent/pi-tool-compat';
import type { GhostbuildToolSet } from 'ghostbuild-agent/types';
import type { BuilderWorkspaceApi } from '~/agents/builder-workspace-api';
import type { BuilderValidationStage } from '~/lib/common/builder-validation-progress';
import { createWorkersAiTools } from './workers-ai-tools';

type BuilderOperationContext = {
  env: Env;
  userId: string;
  chatInitialId: string;
  agentName: string;
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
    edits: Type.Array(
      Type.Object(
        {
          oldText: Type.String(),
          newText: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
  }),
  exec: Type.Object({
    command: Type.String(),
    cwd: Type.Optional(Type.String()),
    backend: Type.Optional(Type.Literal(COMPUTER_SHELL_BACKEND_IDS[0])),
  }),
} as const satisfies Record<ComputerToolName, ReturnType<typeof Type.Object>>;

const serverParameters = {
  lookupDocs: Type.Object({
    docs: Type.Array(Type.Union(docKeys.map((key) => Type.Literal(key)) as never[]), {
      minItems: 1,
      maxItems: 3,
    }),
    section: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
    query: Type.Optional(Type.String({ minLength: 2, maxLength: 300 })),
    cursor: Type.Optional(Type.String({ maxLength: 64 })),
  }),
  npmInstall: Type.Object({
    mode: Type.Optional(Type.Union([Type.Literal('add'), Type.Literal('sync-lockfile')])),
    packages: Type.Optional(Type.String({ maxLength: 2_000 })),
  }),
  validateProject: Type.Object({}),
  deploy: Type.Object({
    validatedRevision: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  }),
} as const;

const toolLabels = {
  read: 'Read file',
  ls: 'List files',
  write: 'Write file',
  edit: 'Edit file',
  exec: 'Run command',
  lookupDocs: 'Look up documentation',
  npmInstall: 'Install dependencies',
  validateProject: 'Validate project',
  deploy: 'Deploy project',
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

  for (const name of COMPUTER_TOOL_NAMES) {
    tools[name] = adaptTool(name, toolLabels[name], canonicalTools[name], computerParameters[name]);
  }
  for (const name of ['lookupDocs', 'npmInstall', 'validateProject', 'deploy'] as const) {
    tools[name] = adaptTool(name, toolLabels[name], canonicalTools[name], serverParameters[name]);
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
    execute: async (toolCallId, args, signal) => {
      signal?.throwIfAborted();
      if (!definition.execute) {
        throw new Error(`${name} is not executable.`);
      }
      const result = await definition.execute(args, { toolCallId, abortSignal: signal });
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
