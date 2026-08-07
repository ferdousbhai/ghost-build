import type { TSchema } from '@earendil-works/pi-ai';

// Pi harness Tool compat — replaces ai:Tool for ghostbuild-agent
// Minimal shape matching ghostbuild-agent usage: description + inputSchema
export type Tool = {
  description?: string;
  inputSchema?: TSchema | unknown;
  execute?: (input: unknown, options: { toolCallId: string; abortSignal?: AbortSignal }) => Promise<unknown>;
};

export type ToolSet = Record<string, Tool>;
export type ToolExecutionOptions = { toolCallId: string; abortSignal?: AbortSignal };
