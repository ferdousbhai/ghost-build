import { Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { BuilderWorkspaceApi } from '~/agents/builder-workspace-api';
import type { BuilderValidationStage } from '~/lib/common/builder-validation-progress';
import { COMPUTER_TOOL_NAMES, type ComputerToolName } from 'ghostbuild-agent/cloudflare-computer';
import { createAITools } from '@cloudflare/computer/tools';
import { COMPUTER_AI_TOOL_OPTIONS } from 'ghostbuild-agent/cloudflare-computer';
import type { GhostbuildToolName } from 'ghostbuild-agent/types';

// Bridge: existing ghost-build workspace tool execution (zod/ai) -> pi AgentTool (TypeBox)
// We reuse the exact execution logic from workers-ai-tools.ts (coordinateStatefulTool +
// executeBuilderOperationTool) but expose it via TypeBox schemas so pi can validate.
//
// Schemas mirror ghostbuild-agent/tools/*.ts but as TypeBox, per cloudflare-os defineTool pattern.

type BuilderOperationContext = {
  env: Env;
  userId: string;
  chatInitialId: string;
  agentName: string;
  onValidationStage?: (toolCallId: string, stage: BuilderValidationStage | null) => void;
  runWithKeepAlive: <T>(operation: () => Promise<T>) => Promise<T>;
};

function defineTool<T extends ReturnType<typeof Type.Object>>(def: AgentTool<T>): AgentTool {
  return def as unknown as AgentTool;
}

function createTurnStatefulToolCoordinator(runWithKeepAlive: BuilderOperationContext['runWithKeepAlive']) {
  const pending = new Map<string, Promise<unknown>>();
  return async <T>(toolName: GhostbuildToolName, operation: () => Promise<T>): Promise<T> => {
    // serialize stateful tools (validateProject/deploy/exec) like workers-ai-tools
    const key = toolName;
    const prev = pending.get(key);
    if (prev) await prev.catch(() => {});
    const p = runWithKeepAlive(operation);
    pending.set(key, p);
    try {
      return await p;
    } finally {
      if (pending.get(key) === p) pending.delete(key);
    }
  };
}

export function createPiTools(
  workspace: BuilderWorkspaceApi,
  operationContext: BuilderOperationContext,
): Record<string, AgentTool> {
  const coordinateStatefulTool = createTurnStatefulToolCoordinator(operationContext.runWithKeepAlive);

  // Computer tools schemas adapted from @cloudflare/computer — expose as simple TypeBox objects
  // Execution delegates to the same workspace.computer backend via createAITools internals.
  // We create pi tools that call the AI SDK tool's execute via a shared helper.

  // Fallback: build AI SDK computer tools to reuse their description/inputSchema for bridging
  // but execution goes through pi's handler calling executeBuilderOperationTool directly.
  const aiComputerTools = createAITools({ workspace: workspace.computer, ...COMPUTER_AI_TOOL_OPTIONS }) as Record<
    string,
    { description?: string; inputSchema?: unknown }
  >;

  const tools: Record<string, AgentTool> = {};

  for (const name of COMPUTER_TOOL_NAMES) {
    const desc = (aiComputerTools[name]?.description as string) ?? `${name} workspace file tool`;
    tools[name] = defineTool({
      name,
      description: desc,
      parameters: Type.Object({
        path: Type.Optional(Type.String({ description: 'File path' })),
        content: Type.Optional(Type.String({ description: 'File content' })),
        oldContent: Type.Optional(Type.String({ description: 'Old content for edit' })),
        newContent: Type.Optional(Type.String({ description: 'New content for edit' })),
        command: Type.Optional(Type.String({ description: 'Shell command for exec' })),
      }),
      execute: async (toolCallId, args) => {
        operationContext.runWithKeepAlive; // keep alive wrapper
        // Delegate to the builder-operation tool pipeline used by workers-ai-tools serverOperationTool
        const { executeBuilderOperationTool } = await import('~/agents/builder-operation-tools');
        // computer tools use same pipeline with toolName as computer name
        return coordinateStatefulTool(name as GhostbuildToolName, async () =>
          executeBuilderOperationTool({
            context: operationContext,
            workspace,
            toolCallId,
            toolName: name as never,
            input: args as Record<string, unknown>,
            abortSignal: undefined,
          }),
        );
      },
    });
  }

  // Ghostbuild-specific tools — TypeBox schemas faithful to ghostbuild-agent/tools
  tools['lookupDocs'] = defineTool({
    name: 'lookupDocs',
    description: 'Lookup bounded documentation sections and skill references.',
    parameters: Type.Object({
      docs: Type.Array(Type.String(), { minItems: 1, maxItems: 3 }),
      section: Type.Optional(Type.String({ maxLength: 300 })),
      query: Type.Optional(Type.String({ minLength: 2, maxLength: 300 })),
      cursor: Type.Optional(Type.String({ maxLength: 64 })),
    }),
    execute: async (toolCallId, args) => {
      const { executeBuilderOperationTool } = await import('~/agents/builder-operation-tools');
      return coordinateStatefulTool('lookupDocs', async () =>
        executeBuilderOperationTool({
          context: operationContext,
          workspace,
          toolCallId,
          toolName: 'lookupDocs',
          input: args as Record<string, unknown>,
          abortSignal: undefined,
        }),
      );
    },
  });

  tools['npmInstall'] = defineTool({
    name: 'npmInstall',
    description: 'Install npm dependencies.',
    parameters: Type.Object({
      specs: Type.Optional(Type.Array(Type.String())),
    }),
    execute: async (toolCallId, args) => {
      const { executeBuilderOperationTool } = await import('~/agents/builder-operation-tools');
      return coordinateStatefulTool('npmInstall', async () =>
        executeBuilderOperationTool({
          context: operationContext,
          workspace,
          toolCallId,
          toolName: 'npmInstall',
          input: args as Record<string, unknown>,
          abortSignal: undefined,
        }),
      );
    },
  });

  tools['validateProject'] = defineTool({
    name: 'validateProject',
    description: 'Run full project validation (typecheck, build, lint).',
    parameters: Type.Object({}),
    execute: async (toolCallId, args) => {
      const { executeBuilderOperationTool } = await import('~/agents/builder-operation-tools');
      return coordinateStatefulTool('validateProject', async () =>
        executeBuilderOperationTool({
          context: operationContext,
          workspace,
          toolCallId,
          toolName: 'validateProject',
          input: args as Record<string, unknown>,
          abortSignal: undefined,
        }),
      );
    },
  });

  tools['deploy'] = defineTool({
    name: 'deploy',
    description: 'Prepare and execute production deployment after validation.',
    parameters: Type.Object({
      validatedRevision: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    }),
    execute: async (toolCallId, args) => {
      const { executeBuilderOperationTool } = await import('~/agents/builder-operation-tools');
      return coordinateStatefulTool('deploy', async () =>
        executeBuilderOperationTool({
          context: operationContext,
          workspace,
          toolCallId,
          toolName: 'deploy',
          input: args as Record<string, unknown>,
          abortSignal: undefined,
        }),
      );
    },
  });

  return tools;
}

export function piToolsToList(tools: Record<string, AgentTool>): AgentTool[] {
  return Object.values(tools);
}
