import type { Message, Tool, ToolCall } from '@earendil-works/pi-ai';
import type { ModelHandle } from './pi-ai-models';

// Verbatim port of cloudflare-os/packages/workshop-backend/src/ai-invoke.ts

export class AgentTurnError extends Error {
  readonly statusCode?: number;
  constructor(message: string, statusCode?: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

function httpStatusFromError(errorMessage: string, handle: ModelHandle): number | undefined {
  const match = /^(\d{3})\b/.exec(errorMessage.trim());
  if (match) {
    return Number(match[1]);
  }
  return handle.lastResponse?.status;
}

export async function completeText(
  handle: ModelHandle,
  args: {
    systemPrompt?: string;
    prompt?: string;
    messages?: Message[];
    maxTokens?: number;
    temperature?: number;
    signal?: AbortSignal;
  },
): Promise<string> {
  const messages: Message[] = args.messages ?? [{ role: 'user', content: args.prompt ?? '', timestamp: Date.now() }];
  const stream = await handle.stream(
    handle.model,
    { systemPrompt: args.systemPrompt, messages },
    { maxTokens: args.maxTokens, temperature: args.temperature, signal: args.signal, thinking: false },
  );
  const message = await stream.result();
  if (message.stopReason === 'error' || message.stopReason === 'aborted') {
    args.signal?.throwIfAborted();
    const errorMessage = message.errorMessage ?? 'The model request failed.';
    throw new AgentTurnError(errorMessage, httpStatusFromError(errorMessage, handle));
  }
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => (block as { text: string }).text)
    .join('');
}

export async function completeToolCall(
  handle: ModelHandle,
  args: {
    systemPrompt: string;
    prompt: string;
    tool: Tool;
    maxTokens?: number;
    temperature?: number;
    signal?: AbortSignal;
  },
): Promise<Record<string, unknown>> {
  const stream = await handle.stream(
    handle.model,
    {
      systemPrompt: args.systemPrompt,
      messages: [{ role: 'user', content: args.prompt, timestamp: Date.now() }],
      tools: [args.tool],
    },
    {
      maxTokens: args.maxTokens,
      temperature: args.temperature,
      signal: args.signal,
      thinking: false,
      toolChoice: { type: 'function', function: { name: args.tool.name } },
    },
  );
  const message = await stream.result();
  if (message.stopReason === 'error' || message.stopReason === 'aborted') {
    args.signal?.throwIfAborted();
    const errorMessage = message.errorMessage ?? 'The model request failed.';
    throw new AgentTurnError(errorMessage, httpStatusFromError(errorMessage, handle));
  }
  const calls = message.content.filter(
    (block): block is ToolCall => block.type === 'toolCall' && block.name === args.tool.name,
  );
  if (calls.length !== 1) {
    throw new AgentTurnError('The model returned an invalid structured response.');
  }
  return calls[0]!.arguments;
}
